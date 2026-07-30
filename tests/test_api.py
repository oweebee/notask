"""Tests bout en bout : verrouillage initial, comptes, notes, notâches, réglages."""

import os
import tempfile
from datetime import datetime, timedelta, timezone

_TMP = tempfile.mkdtemp()
os.environ["NOTASK_DATA_DIR"] = _TMP
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"

from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import SQLModel  # noqa: E402

from app.db import engine  # noqa: E402
from app.main import app  # noqa: E402

SQLModel.metadata.create_all(engine)
client = TestClient(app)

ADMIN = {"username": "admin", "password": "motdepasse1"}
BOB = {"username": "bob", "password": "motdepasse2"}


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def iso(**delta):
    return (datetime.now(timezone.utc) + timedelta(**delta)).isoformat()


def test_verrouillage_et_comptes():
    assert client.get("/api/auth/status").json()["needs_setup"] is True
    assert client.get("/api/notes").status_code == 401
    assert client.post("/api/auth/login", json=ADMIN).status_code == 409

    r = client.post("/api/auth/setup", json={**ADMIN, "is_admin": True})
    assert r.status_code == 201, r.text
    assert r.json()["user"]["is_admin"] is True
    assert client.get("/api/auth/status").json()["needs_setup"] is False
    assert client.post("/api/auth/setup", json=ADMIN).status_code == 409

    token = r.json()["access_token"]
    assert client.post("/api/auth/login", json={"username": "admin", "password": "faux"}).status_code == 401

    # Création d'un second compte, puis cloisonnement
    r = client.post("/api/users", json={**BOB, "is_admin": False}, headers=auth(token))
    assert r.status_code == 201
    assert r.json()["must_change_password"] is True
    assert client.post("/api/users", json=BOB, headers=auth(token)).status_code == 409

    bob = client.post("/api/auth/login", json=BOB).json()["access_token"]
    assert client.get("/api/users", headers=auth(bob)).status_code == 403

    # Garde-fous : rester au moins un admin actif
    me = client.get("/api/auth/me", headers=auth(token)).json()
    assert client.patch(f"/api/users/{me['id']}", json={"is_admin": False}, headers=auth(token)).status_code == 400
    assert client.delete(f"/api/users/{me['id']}", headers=auth(token)).status_code == 400

    assert client.get("/api/auth/me", headers=auth("jeton-bidon")).status_code == 401


def test_note_simple():
    """Sans échéance : une note ordinaire, ni tâche ni cochable."""
    t = client.post("/api/auth/login", json=ADMIN).json()["access_token"]

    n = client.post("/api/notes", json={"title": "Idée", "content": "réfléchir", "color": "lime"},
                    headers=auth(t)).json()
    assert n["due_at"] is None
    assert n["done"] is False

    # Elle n'apparaît pas dans les tâches
    assert all(x["note_id"] != n["id"] for x in client.get("/api/tasks", headers=auth(t)).json())

    # Et on ne peut pas la terminer
    r = client.patch(f"/api/notes/{n['id']}", json={"done": True}, headers=auth(t))
    assert r.status_code == 400
    assert "échéance" in r.json()["detail"]
    assert client.patch(f"/api/tasks/note/{n['id']}", json={"done": True}, headers=auth(t)).status_code == 400

    # Couleur inconnue refusée
    assert client.post("/api/notes", json={"title": "x", "color": "fuchsia"}, headers=auth(t)).status_code == 400


def test_note_datee_devient_tache():
    t = client.post("/api/auth/login", json=ADMIN).json()["access_token"]

    n = client.post("/api/notes", json={"title": "Appeler le plombier", "due_at": iso(days=3)},
                    headers=auth(t)).json()

    tasks = client.get("/api/tasks", headers=auth(t)).json()
    mine = [x for x in tasks if x["note_id"] == n["id"]]
    assert len(mine) == 1
    assert mine[0]["kind"] == "note"
    assert mine[0]["bucket"] == "upcoming"

    # Terminer depuis la vue Tâches
    r = client.patch(f"/api/tasks/note/{n['id']}", json={"done": True}, headers=auth(t))
    assert r.status_code == 200
    assert r.json()["bucket"] == "done"
    assert client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()["done_at"] is not None

    # Retirer l'échéance : la note redevient une note, et n'est plus terminée
    back = client.patch(f"/api/notes/{n['id']}", json={"due_at": None}, headers=auth(t)).json()
    assert back["due_at"] is None and back["done"] is False and back["done_at"] is None
    assert all(x["note_id"] != n["id"] for x in client.get("/api/tasks", headers=auth(t)).json())


def test_ligne_datee_devient_tache_autonome():
    t = client.post("/api/auth/login", json=ADMIN).json()["access_token"]

    n = client.post("/api/notes", json={
        "title": "Courses", "is_checklist": True,
        "items": [{"text": "lait"}, {"text": "réserver le train", "due_at": iso(days=-1)}],
    }, headers=auth(t)).json()

    # La note elle-même n'est pas datée : seule la ligne l'est
    assert n["due_at"] is None
    datee = [i for i in n["items"] if i["due_at"]]
    assert len(datee) == 1
    ligne = datee[0]

    tasks = client.get("/api/tasks", headers=auth(t)).json()
    depuis_ligne = [x for x in tasks if x["kind"] == "item" and x["id"] == ligne["id"]]
    assert len(depuis_ligne) == 1
    assert depuis_ligne[0]["note_id"] == n["id"]
    assert depuis_ligne[0]["note_title"] == "Courses"
    assert depuis_ligne[0]["bucket"] == "late"      # échéance dépassée
    assert depuis_ligne[0]["color"] == n["color"]   # couleur héritée de la note

    # La ligne non datée n'est pas une tâche
    assert len([x for x in tasks if x["kind"] == "item"]) == 1

    # Cocher depuis la vue Tâches
    r = client.patch(f"/api/tasks/item/{ligne['id']}", json={"done": True}, headers=auth(t))
    assert r.status_code == 200 and r.json()["bucket"] == "done"

    # Dater une ligne après coup, ligne par ligne
    simple = [i for i in n["items"] if not i["due_at"]][0]
    r = client.patch(f"/api/notes/{n['id']}/items/{simple['id']}",
                     json={"due_at": iso(hours=2)}, headers=auth(t))
    assert r.status_code == 200 and r.json()["due_at"] is not None
    assert len([x for x in client.get("/api/tasks", headers=auth(t)).json() if x["kind"] == "item"]) == 2

    # Cocher une ligne sans échéance est refusé
    n2 = client.post("/api/notes", json={"is_checklist": True, "items": [{"text": "libre"}]},
                     headers=auth(t)).json()
    assert client.patch(f"/api/tasks/item/{n2['items'][0]['id']}",
                        json={"done": True}, headers=auth(t)).status_code == 400


def test_regroupements_et_archives():
    t = client.post("/api/auth/login", json=ADMIN).json()["access_token"]

    retard = client.post("/api/notes", json={"title": "En retard", "due_at": iso(days=-2)},
                         headers=auth(t)).json()
    client.post("/api/notes", json={"title": "Ce soir", "due_at": iso(minutes=30)}, headers=auth(t))

    buckets = {x["bucket"] for x in client.get("/api/tasks", headers=auth(t)).json()}
    assert {"late", "today"} <= buckets

    n_late = client.get("/api/tasks?bucket=late", headers=auth(t)).json()
    assert all(x["bucket"] == "late" for x in n_late) and n_late

    assert client.get("/api/tasks?bucket=nimportequoi", headers=auth(t)).status_code == 400

    # Archiver retire de la vue Tâches, sauf demande explicite
    client.patch(f"/api/notes/{retard['id']}", json={"archived": True}, headers=auth(t))
    assert all(x["note_id"] != retard["id"] for x in client.get("/api/tasks", headers=auth(t)).json())
    inclus = client.get("/api/tasks?include_archived=true", headers=auth(t)).json()
    assert any(x["note_id"] == retard["id"] for x in inclus)

    # Épinglage et recherche restent fonctionnels
    client.patch(f"/api/notes/{retard['id']}", json={"archived": False, "pinned": True}, headers=auth(t))
    assert client.get("/api/notes", headers=auth(t)).json()[0]["id"] == retard["id"]
    assert client.get("/api/notes?q=retard", headers=auth(t)).json()


def test_cloisonnement():
    t = client.post("/api/auth/login", json=ADMIN).json()["access_token"]
    bob = client.post("/api/auth/login", json=BOB).json()["access_token"]

    n = client.post("/api/notes", json={"title": "Privé", "due_at": iso(days=1)}, headers=auth(t)).json()

    assert all(x["note_id"] != n["id"] for x in client.get("/api/tasks", headers=auth(bob)).json())
    assert client.get(f"/api/notes/{n['id']}", headers=auth(bob)).status_code == 404
    assert client.patch(f"/api/notes/{n['id']}", json={"title": "pirate"}, headers=auth(bob)).status_code == 404
    assert client.delete(f"/api/notes/{n['id']}", headers=auth(bob)).status_code == 404
    assert client.patch(f"/api/tasks/note/{n['id']}", json={"done": True}, headers=auth(bob)).status_code == 404


def test_libelles():
    t = client.post("/api/auth/login", json=ADMIN).json()["access_token"]
    bob = client.post("/api/auth/login", json=BOB).json()["access_token"]

    assert client.get("/api/labels", headers=auth(t)).json() == []

    maison = client.post("/api/labels", json={"name": "Maison"}, headers=auth(t)).json()
    travail = client.post("/api/labels", json={"name": "Travail"}, headers=auth(t)).json()
    assert maison["id"] != travail["id"]

    # Nom en double refusé pour le même utilisateur
    assert client.post("/api/labels", json={"name": "Maison"}, headers=auth(t)).status_code == 409
    # Nom vide (ou blanc) refusé
    assert client.post("/api/labels", json={"name": "   "}, headers=auth(t)).status_code == 400

    # Chaque utilisateur a ses propres libellés
    assert client.get("/api/labels", headers=auth(bob)).json() == []

    # Attribution d'un libellé à une note, à la création
    n = client.post("/api/notes", json={"title": "Courses", "label_ids": [maison["id"]]},
                     headers=auth(t)).json()
    assert n["label_ids"] == [maison["id"]]

    # Un libellé qui n'appartient pas à l'utilisateur (ou inexistant) est refusé
    assert client.post("/api/notes", json={"title": "x", "label_ids": [999999]},
                        headers=auth(t)).status_code == 400

    # Mise à jour des libellés d'une note existante
    r = client.patch(f"/api/notes/{n['id']}", json={"label_ids": [maison["id"], travail["id"]]},
                      headers=auth(t))
    assert sorted(r.json()["label_ids"]) == sorted([maison["id"], travail["id"]])

    # Filtrage des notes par libellé
    autre = client.post("/api/notes", json={"title": "Sans libellé"}, headers=auth(t)).json()
    filtrees = client.get(f"/api/notes?label={travail['id']}", headers=auth(t)).json()
    assert {x["id"] for x in filtrees} == {n["id"]}
    assert autre["id"] not in {x["id"] for x in filtrees}

    # Renommage
    renomme = client.patch(f"/api/labels/{maison['id']}", json={"name": "Domicile"}, headers=auth(t)).json()
    assert renomme["name"] == "Domicile"

    # Suppression : nettoie la référence orpheline dans label_ids
    client.delete(f"/api/labels/{maison['id']}", headers=auth(t))
    note_apres = client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()
    assert maison["id"] not in note_apres["label_ids"]
    assert travail["id"] in note_apres["label_ids"]

    # Cloisonnement : bob ne peut ni modifier ni supprimer un libellé d'admin
    assert client.patch(f"/api/labels/{travail['id']}", json={"name": "vol"}, headers=auth(bob)).status_code == 404
    assert client.delete(f"/api/labels/{travail['id']}", headers=auth(bob)).status_code == 404


def test_icone_note_et_couleur_libelle():
    t = client.post("/api/auth/login", json=ADMIN).json()["access_token"]

    # Icône sur une note, à la création puis à l'édition
    n = client.post("/api/notes", json={"title": "Courses", "icon": "shopping"}, headers=auth(t)).json()
    assert n["icon"] == "shopping"
    r = client.patch(f"/api/notes/{n['id']}", json={"icon": "star"}, headers=auth(t))
    assert r.json()["icon"] == "star"
    assert client.patch(f"/api/notes/{n['id']}", json={"icon": "inexistant"}, headers=auth(t)).status_code == 400
    assert client.post("/api/notes", json={"title": "x", "icon": "pasunicone"}, headers=auth(t)).status_code == 400

    # Une note sans icône explicite n'en porte aucune
    sans = client.post("/api/notes", json={"title": "Neutre"}, headers=auth(t)).json()
    assert sans["icon"] is None

    # Couleur propre à un libellé, indépendante des couleurs de note
    lbl = client.post("/api/labels", json={"name": "Perso", "color": "teal"}, headers=auth(t)).json()
    assert lbl["color"] == "teal"
    r = client.patch(f"/api/labels/{lbl['id']}", json={"color": "rose"}, headers=auth(t))
    assert r.json()["color"] == "rose"
    assert client.patch(f"/api/labels/{lbl['id']}", json={"color": "fuchsia"}, headers=auth(t)).status_code == 400
    assert client.post("/api/labels", json={"name": "Bidon", "color": "fuchsia"}, headers=auth(t)).status_code == 400

    # Effacer la couleur (revenir à "aucune")
    r = client.patch(f"/api/labels/{lbl['id']}", json={"color": None}, headers=auth(t))
    assert r.json()["color"] is None


def test_reglages():
    t = client.post("/api/auth/login", json=ADMIN).json()["access_token"]

    assert client.get("/api/settings", headers=auth(t)).json() == {}
    r = client.patch("/api/settings", json={"theme": "dark", "widget": {"n": 3}}, headers=auth(t))
    assert r.json()["widget"]["n"] == 3
    assert client.patch("/api/settings", json={"theme": None}, headers=auth(t)).json() == {"widget": {"n": 3}}
    assert client.put("/api/settings", json={"a": 1}, headers=auth(t)).json() == {"a": 1}
    assert client.put("/api/settings", json={"x": "y" * 20000}, headers=auth(t)).status_code == 400
    assert client.get("/api/settings").status_code == 401
