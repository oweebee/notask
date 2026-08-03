import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import field_validator
from sqlalchemy import JSON, Boolean, Column, String
from sqlmodel import Field, Relationship, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _due_at_utc(v: Optional[datetime]) -> Optional[datetime]:
    """Un `due_at` relu depuis SQLite ressort NAÏF (SQLite n'a aucun support
    natif des fuseaux horaires ; SQLAlchemy perd l'indicateur de fuseau au
    passage, même si la valeur numérique stockée est bien celle envoyée par
    le client — un ISO en UTC, voir partsToIso()/toISOString() dans app.js).
    Sans ce correctif, Pydantic sérialise ce datetime naïf SANS indicateur
    de fuseau ("2026-08-07T08:30:00", pas de Z/+00:00) ; or `new Date(...)`
    côté client interprète alors ce texte comme une heure LOCALE (pas UTC,
    règle du spec ECMAScript pour un ISO sans fuseau) — une échéance posée à
    10h30 (convertie en 08h30 UTC avant l'envoi) réapparaissait donc
    affichée à 08h30 après un rechargement, la conversion UTC->local étant
    appliquée une seconde fois par erreur. Ce correctif ne fait que
    RÉTABLIR l'étiquette UTC sur une valeur déjà numériquement correcte, il
    ne déplace jamais l'heure elle-même."""
    if v is not None and v.tzinfo is None:
        return v.replace(tzinfo=timezone.utc)
    return v


# ============================== Utilisateurs ==============================

class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True, min_length=2, max_length=50)
    password_hash: str
    is_admin: bool = False
    is_active: bool = True
    must_change_password: bool = False
    # --- Chiffrement de bout en bout du contenu des notes (titre/description/
    # contenu/lignes de checklist) ; voir app.js. Le serveur ne stocke que
    # deux chaînes opaques, jamais la clé elle-même :
    #   - enc_salt : sel PBKDF2, dérive une clé de "déverrouillage" (KEK) à
    #     partir du mot de passe de connexion. Généré à l'inscription, ou à
    #     la volée à la prochaine connexion pour les comptes créés avant
    #     cette fonctionnalité (voir routers/auth.py login()).
    #   - wrapped_dek : la vraie clé qui chiffre les notes (DEK), générée
    #     aléatoirement une seule fois côté client puis stockée ici chiffrée
    #     ("enveloppée") par la KEK du moment. Changer son propre mot de
    #     passe ne fait que réenvelopper cette même DEK avec la nouvelle KEK
    #     (voir rewrapDekForNewPassword() dans app.js) — aucune note n'est
    #     donc perdue. Seule une réinitialisation par un administrateur (qui
    #     ne connaît pas l'ancien mot de passe) casse l'enveloppe : une
    #     nouvelle DEK est alors générée, et les notes déjà chiffrées avec
    #     l'ancienne restent définitivement illisibles.
    enc_salt: Optional[str] = Field(default=None, max_length=64)
    wrapped_dek: Optional[str] = Field(default=None, max_length=500)
    created_at: datetime = Field(default_factory=utcnow)


class UserPublic(SQLModel):
    id: int
    username: str
    is_admin: bool
    is_active: bool
    must_change_password: bool
    enc_salt: Optional[str] = None
    wrapped_dek: Optional[str] = None
    created_at: datetime


class EncKeyIn(SQLModel):
    """Clé de chiffrement des notes (DEK), déjà enveloppée côté client par
    la KEK dérivée du mot de passe — le serveur ne fait que la stocker
    telle quelle, sans jamais pouvoir la déchiffrer."""
    wrapped_dek: str = Field(max_length=500)


class UserCreate(SQLModel):
    username: str = Field(min_length=2, max_length=50)
    password: str = Field(min_length=8, max_length=200)
    is_admin: bool = False


class UserUpdate(SQLModel):
    password: Optional[str] = Field(default=None, min_length=8, max_length=200)
    is_admin: Optional[bool] = None
    is_active: Optional[bool] = None


class PasswordChange(SQLModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


class LoginRequest(SQLModel):
    username: str
    password: str


class Token(SQLModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


# =============================== Réglages ===============================

class UserSettings(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True, unique=True)
    data: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    updated_at: datetime = Field(default_factory=utcnow)


# ============================ Google Calendar ============================
# Synchro optionnelle, par utilisateur : une notask (ou une ligne à cocher)
# datée est répercutée comme événement dans Google Calendar. Compromis de
# chiffrement explicitement accepté par l'utilisateur (pas supposé) : pour
# les notasks/lignes AVEC échéance seulement, le serveur voit désormais le
# titre en clair (voir Note.calendar_title / NoteItem.calendar_title
# ci-dessous), en plus de la date déjà en clair aujourd'hui (due_at). Le
# reste (description, contenu, pièces jointes, notasks sans échéance) reste
# chiffré de bout en bout comme avant, intégralement inchangé.
#
# Cette table ne doit JAMAIS être exposée via /api/settings (objet JSON
# libre renvoyé tel quel au client) : refresh_token/access_token y seraient
# sinon reservis au client à chaque lecture des réglages. Elle vit dans sa
# propre table, avec son propre routeur (app/routers/google.py), dont aucune
# route ne renvoie jamais ces deux champs — seulement un statut
# connecté/déconnecté/à reconnecter (needs_reauth) et l'e-mail du compte.

class GoogleAppConfig(SQLModel, table=True):
    """Identifiants OAuth de l'appli (Client ID/Secret Google Cloud), une
    seule ligne pour toute l'installation — pas par utilisateur, contrairement
    à GoogleAccount ci-dessous. Configurable depuis l'écran admin (onglet
    Comptes) plutôt qu'en variables d'environnement uniquement : évite d'avoir
    à passer par Coolify. Repli sur GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET
    (variables d'environnement) tant qu'aucune ligne n'existe ici — voir
    google_calendar.py::_client_config(). Comme UserSettings/GoogleAccount,
    jamais renvoyée telle quelle à un client (voir GoogleAdminConfigOut plus
    bas, qui ne renvoie jamais client_secret)."""
    id: Optional[int] = Field(default=None, primary_key=True)
    client_id: Optional[str] = Field(default=None, max_length=500)
    client_secret: Optional[str] = Field(default=None, max_length=500)
    # Adresse publique de l'installation (ex. https://notask.example.com),
    # relevée automatiquement lors de la connexion Google (le callback OAuth
    # est la seule requête où le serveur connaît à coup sûr son adresse
    # publique vue du navigateur, voir _redirect_uri dans routers/google.py).
    # Sert à construire le lien « Ouvrir dans notask » mis dans la
    # description des événements — la synchro n'a sinon aucun moyen de
    # deviner cette adresse, aucun contexte de requête ne lui parvenant.
    # Repli sur la variable d'environnement APP_BASE_URL.
    base_url: Optional[str] = Field(default=None, max_length=500)
    updated_at: datetime = Field(default_factory=utcnow)


class GoogleAdminConfigOut(SQLModel):
    client_id: Optional[str] = None
    has_secret: bool = False
    # "database" (configuré depuis l'écran admin), "environment" (variables
    # d'environnement), "none" (rien de configuré nulle part).
    source: str = "none"


class GoogleAdminConfigIn(SQLModel):
    client_id: str = Field(min_length=1, max_length=500)
    # Vide/absent => on garde le secret déjà enregistré (voir set_admin_config
    # dans routers/google.py) : évite d'avoir à le retaper si seul le Client
    # ID change, et permet à l'UI de ne jamais réafficher le secret existant
    # en clair dans le champ.
    client_secret: Optional[str] = Field(default=None, max_length=500)


class GoogleCalendarIn(SQLModel):
    """Agenda de destination choisi dans Profil. Un identifiant d'agenda
    Google est soit "primary", soit une adresse (…@group.calendar.google.com
    pour un agenda secondaire) — d'où une simple chaîne, saisissable à la
    main quand la liste déroulante n'est pas disponible (voir SCOPES dans
    google_calendar.py)."""
    calendar_id: str = Field(min_length=1, max_length=200)


class GoogleAccount(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True, unique=True)
    # E-mail du compte Google connecté — affichage seulement, jamais utilisé
    # pour l'authentification elle-même.
    email: Optional[str] = Field(default=None, max_length=200)
    refresh_token: str = Field(max_length=1000)
    access_token: Optional[str] = Field(default=None, max_length=1000)
    access_token_expires_at: Optional[datetime] = None
    # "primary" par défaut : le calendrier principal du compte Google. Pas
    # de sélecteur de calendrier dans cette première version.
    calendar_id: str = Field(default="primary", max_length=200)
    # Jeton de tirage incrémental (Google Calendar Events.list?syncToken=...)
    # — permet de ne récupérer que ce qui a changé côté Google depuis le
    # dernier passage, sans tout retélécharger. None => prochain tirage fait
    # une synchro complète et initialise ce jeton.
    sync_token: Optional[str] = Field(default=None, max_length=2000)
    # Posé à vrai dès qu'un rafraîchissement de jeton échoue (refresh_token
    # révoqué ou expiré côté Google) — c'est le repère affiché côté client
    # ("reconnexion nécessaire") plutôt que de deviner depuis un code
    # d'erreur HTTP à chaque fois.
    needs_reauth: bool = False
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class GoogleAccountStatus(SQLModel):
    """Ce que /api/google/status renvoie — jamais les jetons eux-mêmes."""
    connected: bool
    email: Optional[str] = None
    needs_reauth: bool = False


# État CSRF éphémère du flux OAuth (voir app/routers/google.py connect()/
# callback()). Un identifiant aléatoire opaque tient lieu de paramètre
# `state` envoyé à Google — la clé JWT du site n'est elle-même jamais
# transmise à Google, seulement à /api/google/connect (notre propre
# serveur, en HTTPS). Ligne à usage unique, supprimée dès consommée par
# callback() ou si expirée (nettoyage paresseux, comme _purge_expired_trash
# dans routers/notes.py — même philosophie : pas de tâche planifiée).
class GoogleOAuthState(SQLModel, table=True):
    state: str = Field(primary_key=True, max_length=64)
    user_id: int = Field(foreign_key="user.id", index=True)
    created_at: datetime = Field(default_factory=utcnow)


# ================================= Notes =================================
# La note est le seul objet que l'utilisateur crée.
#
# Une note porte éventuellement une échéance (`due_at`). Dans ce cas elle
# devient une tâche : elle apparaît dans la vue Tâches et devient cochable.
# Sans échéance, c'est une note ordinaire, non cochable.
#
# Chaque case à cocher d'une note peut elle aussi porter sa propre échéance.
# La ligne devient alors une tâche à part entière, sans changer d'apparence
# à l'intérieur de la note.

class NoteBase(SQLModel):
    # 2000 plutôt que les 300 caractères d'origine : titre/description sont
    # potentiellement chiffrés de bout en bout côté client (voir app.js
    # encryptField()), et le texte chiffré + IV + balise + base64 peut peser
    # plusieurs fois la taille du texte en clair. Le serveur ne voit qu'une
    # chaîne opaque, il n'a pas à comprendre son contenu.
    title: str = Field(default="", max_length=2000)
    # Sous-titre facultatif, affiché en italique entre le titre et le
    # contenu — masqué entièrement s'il est vide (voir NoteOut côté clients).
    description: str = Field(default="", max_length=2000)
    content: str = ""
    color: str = Field(default="default", max_length=20)
    pinned: bool = False
    archived: bool = False
    is_checklist: bool = False
    # Échéance de la note entière. Non nulle => c'est une tâche.
    due_at: Optional[datetime] = None
    # Fin de plage, facultative. Non nulle => l'échéance couvre une PÉRIODE
    # (due_at -> due_end_at) au lieu d'un instant, et l'événement Google
    # correspondant dure jusque-là au lieu des 30 minutes par défaut (voir
    # DEFAULT_DURATION dans google_calendar.py). Toujours None quand due_at
    # l'est : une fin sans début n'aurait aucun sens.
    due_end_at: Optional[datetime] = None
    # Icône facultative affichée à gauche de la note (clé parmi un jeu fixe,
    # voir ICON_KEYS dans app/routers/notes.py).
    icon: Optional[str] = Field(default=None, max_length=40)
    # Masque le contenu de la notask dans la mosaïque d'accueil derrière une
    # animation de caractères (voir .matrix-mask côté client). Protection
    # visuelle contre un regard ou une photo par-dessus l'épaule, rien de
    # plus : le contenu part et revient en clair comme n'importe quel autre,
    # et reste lisible dès qu'on ouvre la notask.
    masked: bool = False

    # Cf. _due_at_utc() en tête de fichier — rétablit l'étiquette UTC perdue
    # par SQLite/SQLAlchemy à la lecture, pour toute classe héritant de
    # NoteBase (NoteOut, NoteCreate).
    @field_validator("due_at", "due_end_at", mode="after")
    @classmethod
    def _due_at_tz(cls, v: Optional[datetime]) -> Optional[datetime]:
        return _due_at_utc(v)


class Note(NoteBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    done: bool = False
    done_at: Optional[datetime] = None
    # Corbeille : non nul => la note est "supprimée" mais pas encore purgée.
    # Une suppression normale (bouton corbeille sur la carte) se contente de
    # poser cette date ; la suppression définitive (fichiers, lignes, pièces
    # jointes, historique) n'a lieu que 30 jours plus tard (purge auto, voir
    # _purge_expired_trash dans app/routers/notes.py) ou en resupprimant une
    # note déjà en corbeille. Une note en corbeille n'apparaît plus dans
    # aucune autre vue (notes, archives, tâches), voir list_notes()/tasks.py.
    trashed_at: Optional[datetime] = None
    # --- Synchro Google Calendar (voir bloc "Google Calendar" plus haut) ---
    # Miroir en clair du titre, envoyé par le client UNIQUEMENT quand due_at
    # est posée (c'est lui, jamais `title` qui reste chiffré, qui sert à
    # construire l'événement Google). Remis à None dès que due_at est retiré,
    # que la notask est archivée ou mise à la corbeille (voir update_note/
    # delete_note dans routers/notes.py) — évite qu'un titre en clair traîne
    # au-delà du moment où il sert réellement.
    calendar_title: Optional[str] = Field(default=None, max_length=2000)
    # Identifiant de l'événement côté Google, pour le retrouver au moment de
    # le mettre à jour ou le supprimer. None => jamais synchronisé (compte
    # non connecté, ou pas encore d'échéance au moment de la création).
    google_event_id: Optional[str] = Field(default=None, max_length=200)
    # Redéclaré ici avec NOT NULL + server_default '' (contrairement à la
    # version héritée de NoteBase, nullable par défaut) : sans quoi la
    # migration ajoutant cette colonne à une table `note` déjà peuplée
    # laisse les anciennes notes à NULL, et NoteOut (description: str, non
    # optionnel) refuse alors de les sérialiser — même piège que label_ids.
    description: str = Field(
        default="",
        max_length=2000,
        sa_column=Column(String(2000), nullable=False, server_default=""),
    )
    # Identifiants des libellés (catégories) attachés à la note.
    # Stocké en JSON plutôt qu'en table de liaison : une note appartenant à
    # un seul utilisateur, une petite liste d'entiers suffit.
    # NOT NULL + server_default '[]' : la migration ajoutant cette colonne à
    # une table `note` déjà peuplée (déploiement existant) doit pouvoir
    # remplir les lignes existantes avec une liste vide, jamais NULL — sinon
    # la sérialisation NoteOut (List[int]) échoue sur les anciennes notes.
    label_ids: List[int] = Field(
        default_factory=list,
        sa_column=Column(JSON, nullable=False, server_default="[]"),
    )
    # Ordre manuel (glisser-déposer dans la mosaïque). Plus grand = plus haut
    # dans la liste. Initialisé à l'horloge de création, comme le tri par
    # date précédent ; les notes déjà en base avant cette colonne reçoivent 0
    # via la migration et retombent alors sur le tri par updated_at (tri
    # secondaire dans notes.py), donc aucune note existante ne "saute".
    position: float = Field(default_factory=time.time)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    items: List["NoteItem"] = Relationship(
        back_populates="note",
        sa_relationship_kwargs={"cascade": "all, delete-orphan", "order_by": "NoteItem.position"},
    )
    attachments: List["NoteAttachment"] = Relationship(
        back_populates="note",
        sa_relationship_kwargs={"cascade": "all, delete-orphan", "order_by": "NoteAttachment.created_at"},
    )
    versions: List["NoteVersion"] = Relationship(
        back_populates="note",
        sa_relationship_kwargs={"cascade": "all, delete-orphan", "order_by": "NoteVersion.created_at"},
    )


class NoteItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    note_id: int = Field(foreign_key="note.id", index=True)
    # Cf. NoteBase.title : marge pour le texte chiffré de bout en bout.
    text: str = Field(default="", max_length=3000)
    checked: bool = False
    position: int = 0
    # Échéance propre à la ligne. Non nulle => la ligne est une tâche.
    due_at: Optional[datetime] = None
    # Cf. NoteBase.due_end_at — fin de plage facultative, à l'échelle de la ligne.
    due_end_at: Optional[datetime] = None
    # Cf. Note.calendar_title/google_event_id — même principe, à l'échelle
    # de la ligne : une ligne à cocher datée devient elle-même un événement
    # Google Calendar séparé, indépendant de celui de la notask parente.
    calendar_title: Optional[str] = Field(default=None, max_length=3000)
    google_event_id: Optional[str] = Field(default=None, max_length=200)
    # Archivage/corbeille à l'échelle de la LIGNE, indépendamment de la
    # notask parente : depuis la vue "notasks prévues", une ligne datée
    # s'archive ou se jette seule, sans emporter les autres lignes de sa
    # notask. Une ligne ainsi mise de côté disparaît des tâches et de Google
    # Calendar, mais reste dans sa notask d'origine (voir renderNotes, qui
    # la masque, et le commentaire de sync_item).
    archived: bool = Field(default=False, sa_column=Column(Boolean, nullable=False, server_default="0"))
    trashed_at: Optional[datetime] = None

    note: Optional[Note] = Relationship(back_populates="items")


class NoteItemIn(SQLModel):
    id: Optional[int] = None
    text: str = ""
    checked: bool = False
    due_at: Optional[datetime] = None
    calendar_title: Optional[str] = None
    due_end_at: Optional[datetime] = None


class NoteItemUpdate(SQLModel):
    text: Optional[str] = None
    checked: Optional[bool] = None
    due_at: Optional[datetime] = None
    calendar_title: Optional[str] = None
    due_end_at: Optional[datetime] = None
    archived: Optional[bool] = None
    # True = mettre à la corbeille, False = en sortir. Un booléen côté API
    # plutôt que la date brute : le client n'a pas à fabriquer d'horodatage,
    # et la valeur nulle garde son sens habituel ("champ non fourni").
    trashed: Optional[bool] = None


class NoteItemOut(SQLModel):
    id: int
    text: str
    checked: bool
    position: int
    due_at: Optional[datetime] = None
    due_end_at: Optional[datetime] = None
    google_event_id: Optional[str] = None
    archived: bool = False

    @field_validator("due_at", "due_end_at", mode="after")
    @classmethod
    def _due_at_tz(cls, v: Optional[datetime]) -> Optional[datetime]:
        return _due_at_utc(v)


class ArchivedItemOut(SQLModel):
    """Ligne à cocher archivée seule, affichée dans les Archives comme une
    ligne (pas comme une carte de notask) — même présentation que dans
    "notasks prévues". due_at facultatif ici, contrairement à TaskOut : une
    ligne peut avoir été archivée puis avoir perdu son échéance."""
    id: int
    note_id: int
    text: str
    checked: bool
    due_at: Optional[datetime] = None
    due_end_at: Optional[datetime] = None
    color: str
    icon: Optional[str] = None

    @field_validator("due_at", "due_end_at", mode="after")
    @classmethod
    def _due_at_tz(cls, v: Optional[datetime]) -> Optional[datetime]:
        return _due_at_utc(v)


class NoteCreate(NoteBase):
    items: List[NoteItemIn] = []
    label_ids: List[int] = []
    # Cf. Note.calendar_title — miroir en clair du titre, fourni par le
    # client uniquement quand due_at est posée dès la création.
    calendar_title: Optional[str] = None


class NoteUpdate(SQLModel):
    title: Optional[str] = None
    description: Optional[str] = None
    content: Optional[str] = None
    color: Optional[str] = None
    pinned: Optional[bool] = None
    archived: Optional[bool] = None
    is_checklist: Optional[bool] = None
    due_at: Optional[datetime] = None
    due_end_at: Optional[datetime] = None
    done: Optional[bool] = None
    items: Optional[List[NoteItemIn]] = None
    label_ids: Optional[List[int]] = None
    icon: Optional[str] = None
    masked: Optional[bool] = None
    # Nouvelle position manuelle (glisser-déposer) ; voir Note.position.
    position: Optional[float] = None
    # Cf. Note.calendar_title.
    calendar_title: Optional[str] = None


# ============================= Pièces jointes =============================
# Fichier arbitraire (image, document...) rattaché à une note. Comme le
# reste du contenu, il est chiffré de bout en bout côté client avant l'envoi
# (voir encryptBinary()/apiUpload() dans app.js) : le serveur ne stocke que
# des octets opaques et un petit champ `enc_meta` (nom + type MIME, chiffré
# de la même façon que title/description via encryptField). Il ne connaît
# jamais le nom réel ni le contenu du fichier.
#
# Les octets chiffrés vivent sur disque (DATA_DIR/attachments), pas en base
# — un blob de plusieurs Mo n'a rien à faire dans une colonne SQLite. Seul
# le nom de stockage (un UUID généré serveur, jamais le nom d'origine) est
# conservé ici pour retrouver le fichier.

class NoteAttachment(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    note_id: int = Field(foreign_key="note.id", index=True)
    # Nom de fichier sur disque (DATA_DIR/attachments/<storage_name>) —
    # généré côté serveur (uuid4), sans rapport avec le nom d'origine.
    storage_name: str = Field(max_length=64)
    # JSON {"name": ..., "mime": ...} chiffré côté client, même format que
    # les autres champs texte (préfixe "e1:" généré par encryptField).
    enc_meta: str = Field(max_length=2000)
    # Taille en octets du blob chiffré stocké sur disque. Non sensible (ne
    # révèle pas le contenu), conservée en clair pour l'affichage ("2,3 Mo")
    # sans avoir à déchiffrer ni à relire le fichier.
    size: int = 0
    created_at: datetime = Field(default_factory=utcnow)

    note: Optional[Note] = Relationship(back_populates="attachments")


class AttachmentOut(SQLModel):
    id: int
    enc_meta: str
    size: int
    created_at: datetime


class NoteOut(NoteBase):
    id: int
    done: bool
    done_at: Optional[datetime] = None
    trashed_at: Optional[datetime] = None
    label_ids: List[int] = []
    position: float = 0.0
    created_at: datetime
    updated_at: datetime
    items: List[NoteItemOut] = []
    attachments: List[AttachmentOut] = []
    # Cf. Note.google_event_id — indicateur "synchronisé avec Google" côté
    # client, jamais calendar_title en retour (redondant avec title une fois
    # affiché, inutile de le renvoyer).
    google_event_id: Optional[str] = None


# =============================== Historique ================================
# Instantané complet d'une notask (champs + lignes + pièces jointes) pris
# juste avant un changement qui pourrait faire perdre quelque chose :
# modification de contenu réellement différente, suppression d'une pièce
# jointe, remplacement d'une image via l'éditeur (voir POST
# /notes/{id}/versions dans app/routers/note_versions.py). Déclenché par le
# client, pas automatiquement à chaque PATCH : le serveur ne peut pas savoir
# si le contenu chiffré a réellement changé (chaque chiffrement produit un
# texte différent même à plaintext égal, IV aléatoire), seul le client a le
# texte en clair pour comparer avant/après de façon fiable.
#
# Chaque note ne garde que ses 10 derniers instantanés (voir _prune_versions
# dans le routeur) — au-delà, le plus ancien est supprimé, fichiers de
# sauvegarde de pièces jointes compris.

class NoteVersion(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    note_id: int = Field(foreign_key="note.id", index=True)
    created_at: datetime = Field(default_factory=utcnow, index=True)

    title: str = Field(default="", max_length=2000)
    description: str = Field(default="", max_length=2000)
    content: str = ""
    color: str = Field(default="default", max_length=20)
    is_checklist: bool = False
    due_at: Optional[datetime] = None
    icon: Optional[str] = Field(default=None, max_length=40)
    label_ids: List[int] = Field(default_factory=list, sa_column=Column(JSON, nullable=False, server_default="[]"))

    note: Optional[Note] = Relationship(back_populates="versions")
    items: List["NoteVersionItem"] = Relationship(
        back_populates="version",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )
    attachments: List["NoteVersionAttachment"] = Relationship(
        back_populates="version",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )


class NoteVersionItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    version_id: int = Field(foreign_key="noteversion.id", index=True)
    text: str = Field(default="", max_length=3000)
    checked: bool = False
    due_at: Optional[datetime] = None

    version: Optional[NoteVersion] = Relationship(back_populates="items")


class NoteVersionAttachment(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    version_id: int = Field(foreign_key="noteversion.id", index=True)
    # Pièce jointe vivante dont ceci était la copie au moment de
    # l'instantané — sert à décider, à la restauration, s'il faut écraser
    # une pièce jointe existante (même id encore présent) ou en recréer une
    # (id disparu depuis, supprimée ou jamais réassociée). Ne référence pas
    # une ligne réelle (pas de foreign_key) : cette pièce jointe a pu être
    # supprimée depuis sans que l'instantané n'en soit affecté.
    original_attachment_id: Optional[int] = None
    # Copie des octets chiffrés au moment de l'instantané, sous
    # DATA_DIR/attachment_versions/<storage_name> — un fichier séparé de
    # DATA_DIR/attachments, jamais modifié après coup, contrairement à la
    # pièce jointe vivante qui peut être réécrite par l'éditeur d'image.
    storage_name: str = Field(max_length=64)
    enc_meta: str = Field(max_length=2000)
    size: int = 0

    version: Optional[NoteVersion] = Relationship(back_populates="attachments")


class NoteVersionListItem(SQLModel):
    """Résumé affiché dans la liste de l'historique — pas le détail complet
    (contenu/items/pièces jointes), volontairement léger."""
    id: int
    created_at: datetime
    title: str
    color: str
    icon: Optional[str] = None


class NoteVersionAttachmentOut(SQLModel):
    id: int
    enc_meta: str
    size: int


class NoteVersionItemOut(SQLModel):
    text: str
    checked: bool
    due_at: Optional[datetime] = None

    @field_validator("due_at", mode="after")
    @classmethod
    def _due_at_tz(cls, v: Optional[datetime]) -> Optional[datetime]:
        return _due_at_utc(v)


class NoteVersionDetail(NoteVersionListItem):
    description: str
    content: str
    is_checklist: bool
    due_at: Optional[datetime] = None
    label_ids: List[int] = []
    items: List[NoteVersionItemOut] = []

    @field_validator("due_at", mode="after")
    @classmethod
    def _due_at_tz(cls, v: Optional[datetime]) -> Optional[datetime]:
        return _due_at_utc(v)
    attachments: List[NoteVersionAttachmentOut] = []


# ================================ Libellés ================================
# Catégories façon Keep : un nom, affiché dans le menu latéral. Une note peut
# en porter plusieurs (via Note.label_ids).

class LabelBase(SQLModel):
    name: str = Field(min_length=1, max_length=50)
    # Couleur de fond du libellé dans le menu latéral — indépendante de la
    # couleur d'une note quelconque ; None = pas de couleur (fond neutre,
    # seulement mis en évidence au survol comme les autres entrées du menu).
    color: Optional[str] = Field(default=None, max_length=20)


class Label(LabelBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    created_at: datetime = Field(default_factory=utcnow)
    # Ordre manuel (glisser-déposer dans le menu latéral). Plus grand = plus
    # haut dans la liste — même convention que Note.position. Les libellés
    # déjà en base avant cette colonne reçoivent 0 via la migration et
    # retombent alors sur le tri par nom (repli secondaire, voir
    # list_labels() dans labels.py), donc aucun libellé existant ne "saute".
    position: float = Field(default_factory=time.time)


class LabelCreate(LabelBase):
    pass


class LabelUpdate(SQLModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=50)
    color: Optional[str] = None
    position: Optional[float] = None


class LabelOut(LabelBase):
    id: int
    created_at: datetime
    position: float = 0.0


# ================================ Tâches ================================
# Aucune table : une tâche est une vue sur une note datée ou sur une ligne
# à cocher datée. Rien ne se crée ici, tout naît d'une note.

class TaskOut(SQLModel):
    kind: str            # "note" ou "item"
    id: int              # identifiant de la note ou de la ligne
    note_id: int         # note d'origine, toujours renseignée
    note_title: str      # pour situer une ligne dans sa note
    text: str            # libellé affiché
    due_at: datetime
    # Cf. NoteBase.due_end_at — non nulle => la tâche couvre une période.
    due_end_at: Optional[datetime] = None
    done: bool
    color: str
    # Icône de la note d'origine (même pour une tâche issue d'une ligne à
    # cocher) — affichée dans la colonne d'échéances (voir renderAgenda()
    # dans app.js), None si la note n'en a pas.
    icon: Optional[str] = None
    bucket: str          # "late" | "today" | "upcoming" | "done"

    @field_validator("due_at", "due_end_at", mode="after")
    @classmethod
    def _due_at_tz(cls, v: Optional[datetime]) -> Optional[datetime]:
        return _due_at_utc(v)


class TaskDone(SQLModel):
    done: bool
