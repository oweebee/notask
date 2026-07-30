"""Tests bout en bout : configuration initiale, isolation des données, notes, tâches, comptes."""

import os
import tempfile

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


def test_full_flow():
    # --- L'app est verrouillée tant qu'aucun compte n'existe ---
    assert client.get("/api/auth/status").json()["needs_setup"] is True
    assert client.get("/api/notes").status_code == 401
    assert client.post("/api/auth/login", json=ADMIN).status_code == 409

    # --- Configuration initiale ---
    r = client.post("/api/auth/setup", json={**ADMIN, "is_admin": True})
    assert r.status_code == 201, r.text
    admin_token = r.json()["access_token"]
    assert r.json()["user"]["is_admin"] is True
    assert client.get("/api/auth/status").json()["needs_setup"] is False

    # Un second setup doit être refusé
    assert client.post("/api/auth/setup", json={**ADMIN, "is_admin": True}).status_code == 409

    # --- Connexion ---
    assert client.post("/api/auth/login", json={"username": "admin", "password": "faux"}).status_code == 401
    admin_token = client.post("/api/auth/login", json=ADMIN).json()["access_token"]

    # --- Notes : couleur, épinglage, archive, checklist ---
    note = client.post("/api/notes", json={"title": "Courses", "content": "pain", "color": "blue"},
                       headers=auth(admin_token)).json()
    assert note["color"] == "blue"

    check = client.post("/api/notes", json={
        "title": "Liste", "is_checklist": True,
        "items": [{"text": "lait", "checked": False}, {"text": "oeufs", "checked": True}],
    }, headers=auth(admin_token)).json()
    assert len(check["items"]) == 2
    assert check["items"][1]["checked"] is True

    # Couleur invalide refusée
    assert client.post("/api/notes", json={"title": "x", "color": "fluo"},
                       headers=auth(admin_token)).status_code == 400

    # Épingler : la note remonte en tête
    client.patch(f"/api/notes/{check['id']}", json={"pinned": True}, headers=auth(admin_token))
    notes = client.get("/api/notes", headers=auth(admin_token)).json()
    assert notes[0]["id"] == check["id"]

    # Archiver : sort de la vue principale
    client.patch(f"/api/notes/{note['id']}", json={"archived": True}, headers=auth(admin_token))
    assert all(n["id"] != note["id"] for n in client.get("/api/notes", headers=auth(admin_token)).json())
    archived = client.get("/api/notes?archived=true", headers=auth(admin_token)).json()
    assert archived[0]["id"] == note["id"]

    # --- Tâches : liste par défaut, échéance, sous-tâche, terminé ---
    lists = client.get("/api/lists", headers=auth(admin_token)).json()
    assert len(lists) == 1
    lid = lists[0]["id"]

    t = client.post(f"/api/lists/{lid}/tasks",
                    json={"title": "Appeler le plombier", "due_date": "2026-08-01"},
                    headers=auth(admin_token)).json()
    sub = client.post(f"/api/lists/{lid}/tasks",
                      json={"title": "Trouver le numéro", "parent_id": t["id"]},
                      headers=auth(admin_token)).json()
    assert sub["parent_id"] == t["id"]

    # Deux niveaux de sous-tâches refusés
    assert client.post(f"/api/lists/{lid}/tasks",
                       json={"title": "trop profond", "parent_id": sub["id"]},
                       headers=auth(admin_token)).status_code == 400

    # Cocher le parent coche l'enfant
    client.patch(f"/api/tasks/{t['id']}", json={"completed": True}, headers=auth(admin_token))
    tasks = client.get(f"/api/lists/{lid}/tasks", headers=auth(admin_token)).json()
    assert all(x["completed"] for x in tasks)

    # Effacer les terminées
    client.post(f"/api/lists/{lid}/clear-completed", headers=auth(admin_token))
    assert client.get(f"/api/lists/{lid}/tasks", headers=auth(admin_token)).json() == []

    # Dernière liste non supprimable
    assert client.delete(f"/api/lists/{lid}", headers=auth(admin_token)).status_code == 400

    # --- Comptes ---
    r = client.post("/api/users", json={**BOB, "is_admin": False}, headers=auth(admin_token))
    assert r.status_code == 201, r.text
    bob_id = r.json()["id"]
    assert r.json()["must_change_password"] is True

    # Doublon refusé
    assert client.post("/api/users", json=BOB, headers=auth(admin_token)).status_code == 409

    bob_token = client.post("/api/auth/login", json=BOB).json()["access_token"]

    # Un membre ne peut pas gérer les comptes
    assert client.get("/api/users", headers=auth(bob_token)).status_code == 403

    # --- Isolation : bob ne voit pas les données de l'admin ---
    assert client.get("/api/notes", headers=auth(bob_token)).json() == []
    assert client.get(f"/api/notes/{check['id']}", headers=auth(bob_token)).status_code == 404
    assert client.patch(f"/api/notes/{check['id']}", json={"title": "pirate"},
                        headers=auth(bob_token)).status_code == 404
    assert client.delete(f"/api/notes/{check['id']}", headers=auth(bob_token)).status_code == 404
    assert client.get(f"/api/lists/{lid}/tasks", headers=auth(bob_token)).status_code == 404

    # bob a sa propre liste par défaut, distincte
    bob_lists = client.get("/api/lists", headers=auth(bob_token)).json()
    assert bob_lists[0]["id"] != lid

    # --- Changement de mot de passe ---
    assert client.post("/api/auth/password",
                       json={"current_password": "faux", "new_password": "nouveaumdp1"},
                       headers=auth(bob_token)).status_code == 400
    assert client.post("/api/auth/password",
                       json={"current_password": BOB["password"], "new_password": "nouveaumdp1"},
                       headers=auth(bob_token)).status_code == 204
    assert client.post("/api/auth/login", json=BOB).status_code == 401
    assert client.post("/api/auth/login",
                       json={"username": "bob", "password": "nouveaumdp1"}).status_code == 200

    # --- Garde-fous admin ---
    assert client.patch(f"/api/users/{r.json()['id']}", json={"is_active": False},
                        headers=auth(admin_token)).status_code == 200
    me = client.get("/api/auth/me", headers=auth(admin_token)).json()
    assert client.patch(f"/api/users/{me['id']}", json={"is_admin": False},
                        headers=auth(admin_token)).status_code == 400
    assert client.delete(f"/api/users/{me['id']}", headers=auth(admin_token)).status_code == 400

    # Compte désactivé : accès refusé
    assert client.post("/api/auth/login",
                       json={"username": "bob", "password": "nouveaumdp1"}).status_code == 403

    # Suppression de bob et de ses données
    assert client.delete(f"/api/users/{bob_id}", headers=auth(admin_token)).status_code == 204
    assert len(client.get("/api/users", headers=auth(admin_token)).json()) == 1

    # --- Jeton invalide ---
    assert client.get("/api/auth/me", headers=auth("n-importe-quoi")).status_code == 401


def test_settings():
    """Réglages : stockage libre, fusion, suppression de clé, cloisonnement."""
    admin_token = client.post("/api/auth/login", json=ADMIN).json()["access_token"]

    # Vide au départ
    assert client.get("/api/settings", headers=auth(admin_token)).json() == {}

    # Écriture libre : le serveur n'impose aucun schéma
    r = client.patch("/api/settings",
                     json={"theme": "dark", "tri": "date", "widget": {"liste": 3, "compact": True}},
                     headers=auth(admin_token))
    assert r.status_code == 200
    assert r.json()["widget"]["liste"] == 3

    # Fusion : les clés absentes sont conservées
    r = client.patch("/api/settings", json={"theme": "light"}, headers=auth(admin_token))
    assert r.json() == {"theme": "light", "tri": "date", "widget": {"liste": 3, "compact": True}}

    # null supprime la clé
    r = client.patch("/api/settings", json={"tri": None}, headers=auth(admin_token))
    assert "tri" not in r.json()

    # PUT remplace tout
    r = client.put("/api/settings", json={"theme": "auto"}, headers=auth(admin_token))
    assert r.json() == {"theme": "auto"}
    assert client.get("/api/settings", headers=auth(admin_token)).json() == {"theme": "auto"}

    # Garde-fous
    assert client.put("/api/settings", json={"x": "y" * 20000},
                      headers=auth(admin_token)).status_code == 400
    assert client.put("/api/settings", json={str(i): i for i in range(200)},
                      headers=auth(admin_token)).status_code == 400

    # Cloisonnement : un autre compte a ses propres réglages
    client.post("/api/users", json={"username": "zoe", "password": "motdepasse9"},
                headers=auth(admin_token))
    zoe_token = client.post("/api/auth/login",
                            json={"username": "zoe", "password": "motdepasse9"}).json()["access_token"]
    assert client.get("/api/settings", headers=auth(zoe_token)).json() == {}

    # Sans jeton, rien
    assert client.get("/api/settings").status_code == 401
