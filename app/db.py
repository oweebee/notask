import os
from pathlib import Path

from sqlalchemy import inspect, text
from sqlmodel import Session, SQLModel, create_engine

DATA_DIR = Path(os.getenv("NOTASK_DATA_DIR", "/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DATA_DIR / 'notask.db'}")

engine = create_engine(
    DATABASE_URL,
    echo=False,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
)


def _sqlite_default_literal(col) -> str:
    """Valeur de repli pour une colonne NOT NULL ajoutée à une table existante.

    SQLite exige une valeur par défaut pour ADD COLUMN dès que la colonne est
    NOT NULL et que la table contient déjà des lignes. On choisit une valeur
    neutre selon le type ; sans correspondance connue, la contrainte NOT NULL
    est abandonnée plutôt que de faire échouer le démarrage.
    """
    python_type = getattr(col.type, "python_type", None)
    if python_type is bool:
        return "0"
    if python_type in (int,):
        return "0"
    if python_type in (float,):
        return "0.0"
    if python_type is str:
        return "''"
    return ""  # type inconnu : pas de contrainte NOT NULL imposée


def _migrate_sqlite_schema() -> None:
    """Ajoute les colonnes manquantes aux tables déjà existantes.

    Nécessaire car un déploiement peut réutiliser un volume /data créé par
    une version antérieure du modèle de données : `create_all` ne crée que
    les tables absentes, jamais les colonnes manquantes sur une table déjà
    en place.
    """
    if engine.dialect.name != "sqlite":
        return  # migration écrite spécifiquement pour SQLite, seul backend utilisé ici

    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())

    with engine.begin() as conn:
        for table in SQLModel.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue  # table absente : create_all vient de la créer au complet

            existing_columns = {c["name"] for c in inspector.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing_columns:
                    continue

                col_type = col.type.compile(dialect=engine.dialect)
                clause = f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col_type}'

                if not col.nullable:
                    default = _sqlite_default_literal(col)
                    if default:
                        clause += f" NOT NULL DEFAULT {default}"
                    # sinon : colonne ajoutée sans NOT NULL, par prudence

                conn.execute(text(clause))
                print(f"[migration] colonne ajoutée : {table.name}.{col.name}")


def init_db() -> None:
    SQLModel.metadata.create_all(engine)
    _migrate_sqlite_schema()


def get_session():
    with Session(engine) as session:
        yield session
