"""Vérification de la récurrence (hebdo/annuelle) et du regroupement "imminent".

Écrit pour valider empiriquement l'implémentation, pas seulement à la
relecture : chaque scénario passe par l'API réelle, comme le ferait le client.
"""

import os
import tempfile
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

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


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def iso(**delta):
    return (datetime.now(timezone.utc) + timedelta(**delta)).isoformat()


def parse(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def token():
    client.post("/api/auth/setup", json={**ADMIN, "is_admin": True})
    return client.post("/api/auth/login", json=ADMIN).json()["access_token"]


# --------------------------------------------------------------------------
# Regroupement "imminent"
# --------------------------------------------------------------------------

def test_buckets_imminent_vs_upcoming():
    t = token()
    dans3j = client.post("/api/notes", json={"title": "dans 3 jours", "due_at": iso(days=3)},
                         headers=auth(t)).json()
    dans30j = client.post("/api/notes", json={"title": "dans 30 jours", "due_at": iso(days=30)},
                          headers=auth(t)).json()
    aujourdhui = client.post("/api/notes", json={"title": "tout à l'heure", "due_at": iso(minutes=30)},
                             headers=auth(t)).json()

    par_id = {x["note_id"]: x for x in client.get("/api/tasks", headers=auth(t)).json()}
    assert par_id[dans3j["id"]]["bucket"] == "imminent"
    assert par_id[dans30j["id"]]["bucket"] == "upcoming"
    assert par_id[aujourdhui["id"]]["bucket"] == "today"

    # Le filtre par bucket connaît le nouveau regroupement. On ne compare pas
    # la liste entière : les tests partagent la même base (l'engine est créé
    # au premier import de app.db), d'autres notasks datées peuvent y être.
    r = client.get("/api/tasks?bucket=imminent", headers=auth(t))
    assert r.status_code == 200
    renvoyees = {x["note_id"] for x in r.json()}
    assert dans3j["id"] in renvoyees
    assert dans30j["id"] not in renvoyees and aujourdhui["id"] not in renvoyees
    assert all(x["bucket"] == "imminent" for x in r.json())


# --------------------------------------------------------------------------
# Récurrence : notask entière
# --------------------------------------------------------------------------

def test_notask_hebdo_se_replanifie_une_fois_cochee():
    t = token()
    depart = iso(days=2)
    n = client.post("/api/notes", json={"title": "Sortir les poubelles",
                                        "due_at": depart, "recur": "weekly"},
                    headers=auth(t)).json()
    assert n["recur"] == "weekly"

    # Tant qu'elle n'est pas cochée, RIEN ne bouge (règle explicite).
    inchangee = client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()
    assert parse(inchangee["due_at"]) == parse(n["due_at"])
    assert inchangee["done"] is False

    # Cochée depuis la colonne d'échéances -> +7 jours, et PAS terminée
    r = client.patch(f"/api/tasks/note/{n['id']}", json={"done": True}, headers=auth(t))
    assert r.status_code == 200
    apres = r.json()
    assert apres["done"] is False
    assert parse(apres["due_at"]) == parse(depart) + timedelta(days=7)

    # Et c'est bien persisté
    relu = client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()
    assert relu["done"] is False and relu["done_at"] is None
    assert parse(relu["due_at"]) == parse(depart) + timedelta(days=7)
    assert relu["recur"] == "weekly"

    # Deuxième passage : +7 jours de plus (la récurrence ne s'épuise pas)
    client.patch(f"/api/tasks/note/{n['id']}", json={"done": True}, headers=auth(t))
    relu2 = client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()
    assert parse(relu2["due_at"]) == parse(depart) + timedelta(days=14)


def test_notask_annuelle_conserve_la_plage():
    t = token()
    debut = datetime(2026, 3, 10, 9, 0, tzinfo=timezone.utc)
    fin = datetime(2026, 3, 10, 11, 30, tzinfo=timezone.utc)
    n = client.post("/api/notes", json={"title": "Anniversaire", "due_at": debut.isoformat(),
                                        "due_end_at": fin.isoformat(), "recur": "yearly"},
                    headers=auth(t)).json()

    client.patch(f"/api/tasks/note/{n['id']}", json={"done": True}, headers=auth(t))
    relu = client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()
    assert parse(relu["due_at"]) == debut.replace(year=2027)
    assert parse(relu["due_end_at"]) == fin.replace(year=2027)   # durée préservée
    assert relu["done"] is False


def test_notask_sans_recurrence_reste_terminee():
    """Garde-fou : la reprogrammation ne doit toucher QUE les récurrentes."""
    t = token()
    n = client.post("/api/notes", json={"title": "Une seule fois", "due_at": iso(days=1)},
                    headers=auth(t)).json()
    client.patch(f"/api/tasks/note/{n['id']}", json={"done": True}, headers=auth(t))
    relu = client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()
    assert relu["done"] is True and relu["done_at"] is not None


def test_decocher_une_recurrente_ne_replanifie_pas():
    t = token()
    depart = iso(days=2)
    n = client.post("/api/notes", json={"title": "hebdo", "due_at": depart, "recur": "weekly"},
                    headers=auth(t)).json()
    r = client.patch(f"/api/tasks/note/{n['id']}", json={"done": False}, headers=auth(t))
    assert r.status_code == 200
    assert parse(r.json()["due_at"]) == parse(depart)   # aucune avance


def test_retirer_lecheance_retire_la_recurrence():
    t = token()
    n = client.post("/api/notes", json={"title": "x", "due_at": iso(days=1), "recur": "weekly"},
                    headers=auth(t)).json()
    back = client.patch(f"/api/notes/{n['id']}", json={"due_at": None}, headers=auth(t)).json()
    assert back["due_at"] is None and back["recur"] is None


def test_recurrence_inconnue_refusee():
    t = token()
    r = client.post("/api/notes", json={"title": "x", "due_at": iso(days=1), "recur": "mensuel"},
                    headers=auth(t))
    assert r.status_code == 400
    n = client.post("/api/notes", json={"title": "y", "due_at": iso(days=1)}, headers=auth(t)).json()
    assert client.patch(f"/api/notes/{n['id']}", json={"recur": "toutes les lunes"},
                        headers=auth(t)).status_code == 400


# --------------------------------------------------------------------------
# Récurrence : ligne à cocher
# --------------------------------------------------------------------------

def test_ligne_hebdo_se_replanifie_et_narchive_pas_la_notask():
    t = token()
    depart = iso(days=2)
    n = client.post("/api/notes", json={
        "title": "Ménage",
        "items": [{"text": "aspirateur", "due_at": depart, "recur": "weekly"}],
    }, headers=auth(t)).json()
    ligne = n["items"][0]
    assert ligne["recur"] == "weekly"

    # Cochée depuis la colonne d'échéances
    r = client.patch(f"/api/tasks/item/{ligne['id']}", json={"done": True}, headers=auth(t))
    assert r.status_code == 200
    assert r.json()["done"] is False
    assert parse(r.json()["due_at"]) == parse(depart) + timedelta(days=7)

    relu = client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()
    ligne2 = relu["items"][0]
    assert ligne2["checked"] is False
    assert parse(ligne2["due_at"]) == parse(depart) + timedelta(days=7)
    # La seule case de la notask s'est "décochée" toute seule : la notask ne
    # doit donc PAS rester archivée par archiver_si_tout_coche.
    assert relu["archived"] is False


def test_ligne_recurrente_cochee_via_enregistrement_de_la_notask():
    """Second chemin : la case est cochée dans la boîte d'édition, la notask
    entière est réenregistrée (PATCH /notes/{id} avec items)."""
    t = token()
    depart = iso(days=3)
    n = client.post("/api/notes", json={
        "title": "Arrosage",
        "items": [{"text": "plantes", "due_at": depart, "recur": "weekly"}],
    }, headers=auth(t)).json()
    ligne = n["items"][0]

    maj = client.patch(f"/api/notes/{n['id']}", json={"items": [
        {"id": ligne["id"], "text": "plantes", "checked": True,
         "due_at": depart, "recur": "weekly"},
    ]}, headers=auth(t)).json()

    relu = client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()
    l2 = relu["items"][0]
    assert l2["checked"] is False, "la ligne récurrente doit se décocher"
    assert parse(l2["due_at"]) == parse(depart) + timedelta(days=7)
    assert relu["archived"] is False


def test_recurrence_ligne_preservee_entre_deux_enregistrements():
    """Un enregistrement qui ne touche pas à la récurrence ne doit pas
    l'effacer (le client renvoie toujours la liste complète des lignes)."""
    t = token()
    depart = iso(days=3)
    n = client.post("/api/notes", json={
        "title": "n", "items": [{"text": "a", "due_at": depart, "recur": "yearly"}],
    }, headers=auth(t)).json()
    ligne = n["items"][0]

    client.patch(f"/api/notes/{n['id']}", json={"items": [
        {"id": ligne["id"], "text": "a modifié", "checked": False,
         "due_at": depart, "recur": "yearly"},
    ]}, headers=auth(t))
    relu = client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()
    assert relu["items"][0]["recur"] == "yearly"


def test_ajouter_une_recurrence_a_une_notask_deja_terminee_ne_la_replanifie_pas():
    """Régression : la reprogrammation doit dépendre d'une TRANSITION
    (« vient d'être cochée »), pas d'un état (« est cochée »). La boîte
    d'édition n'envoie pas `done` : sans cette distinction, poser une
    récurrence sur une notask déjà terminée la faisait sauter d'une semaine
    sans que rien n'ait été coché."""
    t = token()
    depart = iso(days=1)
    n = client.post("/api/notes", json={"title": "déjà faite", "due_at": depart},
                    headers=auth(t)).json()
    client.patch(f"/api/tasks/note/{n['id']}", json={"done": True}, headers=auth(t))
    assert client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()["done"] is True

    # On ajoute la récurrence après coup, sans toucher à `done`
    maj = client.patch(f"/api/notes/{n['id']}", json={"recur": "weekly"}, headers=auth(t)).json()
    assert maj["recur"] == "weekly"
    assert maj["done"] is True, "elle reste terminée"
    assert parse(maj["due_at"]) == parse(depart), "la date ne doit pas bouger"


def test_reenregistrer_une_ligne_cochee_ne_la_replanifie_pas_deux_fois():
    """Régression : réenregistrer la notask sans rien changer ne doit pas
    faire avancer une ligne récurrente déjà cochée."""
    t = token()
    depart = iso(days=3)
    n = client.post("/api/notes", json={
        "title": "n", "items": [{"text": "a", "due_at": depart, "recur": "weekly"}],
    }, headers=auth(t)).json()
    ligne = n["items"][0]

    # 1er envoi : la case est cochée -> reprogrammation (+7 j), décochée
    client.patch(f"/api/notes/{n['id']}", json={"items": [
        {"id": ligne["id"], "text": "a", "checked": True, "due_at": depart, "recur": "weekly"},
    ]}, headers=auth(t))
    apres1 = client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()["items"][0]
    attendue = parse(depart) + timedelta(days=7)
    assert parse(apres1["due_at"]) == attendue

    # 2e envoi à l'identique (client qui renvoie l'état courant) : rien ne bouge
    client.patch(f"/api/notes/{n['id']}", json={"items": [
        {"id": ligne["id"], "text": "a", "checked": False,
         "due_at": apres1["due_at"], "recur": "weekly"},
    ]}, headers=auth(t))
    apres2 = client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()["items"][0]
    assert parse(apres2["due_at"]) == attendue


# --------------------------------------------------------------------------
# Changement d'heure : une hebdo de 10h doit rester une hebdo de 10h
# --------------------------------------------------------------------------

PARIS = ZoneInfo("Europe/Paris")


def test_hebdo_garde_lheure_locale_au_passage_a_lheure_dete():
    t = token()
    client.patch("/api/settings", json={"timezone": "Europe/Paris"}, headers=auth(t))

    # Mercredi 25 mars 2026, 10h00 à Paris (heure d'hiver). L'heure d'été
    # commence le 29 mars : la semaine suivante change donc de décalage.
    depart = datetime(2026, 3, 25, 10, 0, tzinfo=PARIS)
    n = client.post("/api/notes", json={"title": "poubelles",
                                        "due_at": depart.astimezone(timezone.utc).isoformat(),
                                        "recur": "weekly"}, headers=auth(t)).json()

    client.patch(f"/api/tasks/note/{n['id']}", json={"done": True}, headers=auth(t))
    relu = client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()
    local = parse(relu["due_at"]).astimezone(PARIS)

    assert local.hour == 10 and local.minute == 0, f"attendu 10h00 local, obtenu {local:%H:%M}"
    assert local.date() == datetime(2026, 4, 1).date()   # bien mercredi suivant


def test_hebdo_garde_lheure_locale_au_retour_a_lheure_dhiver():
    t = token()
    client.patch("/api/settings", json={"timezone": "Europe/Paris"}, headers=auth(t))

    # Mercredi 21 octobre 2026 (heure d'été) ; retour à l'heure d'hiver le 25.
    depart = datetime(2026, 10, 21, 10, 0, tzinfo=PARIS)
    n = client.post("/api/notes", json={"title": "poubelles",
                                        "due_at": depart.astimezone(timezone.utc).isoformat(),
                                        "recur": "weekly"}, headers=auth(t)).json()

    client.patch(f"/api/tasks/note/{n['id']}", json={"done": True}, headers=auth(t))
    local = parse(client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()["due_at"]).astimezone(PARIS)

    assert local.hour == 10 and local.minute == 0, f"attendu 10h00 local, obtenu {local:%H:%M}"
    assert local.date() == datetime(2026, 10, 28).date()


def test_journee_complete_reste_a_minuit_utc():
    """Garde-fou : une échéance « journée complète » vaut minuit UTC PAR
    CONVENTION (voir NoteBase.all_day). Elle ne doit surtout pas passer par
    l'heure locale, sinon elle dériverait d'une heure au changement d'heure
    et casserait la convention que tout le reste du code tient pour acquise."""
    t = token()
    client.patch("/api/settings", json={"timezone": "Europe/Paris"}, headers=auth(t))

    jour = datetime(2026, 3, 25, 0, 0, tzinfo=timezone.utc)
    n = client.post("/api/notes", json={"title": "jour entier", "due_at": jour.isoformat(),
                                        "all_day": True, "recur": "weekly"},
                    headers=auth(t)).json()
    assert n["all_day"] is True

    client.patch(f"/api/tasks/note/{n['id']}", json={"done": True}, headers=auth(t))
    suivant = parse(client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()["due_at"])
    assert suivant == datetime(2026, 4, 1, 0, 0, tzinfo=timezone.utc)


def test_nuits_de_changement_dheure_ne_font_pas_planter():
    """Les deux nuits pathologiques, prises directement au niveau du calcul :
    le 29 mars 2026 à Paris, 2h30 N'EXISTE PAS (l'heure est sautée) ; le
    25 octobre, elle existe DEUX FOIS. Une notask hebdomadaire posée à 2h30
    tombe donc dessus une semaine sur l'autre, et ça ne doit ni planter ni
    produire une date absurde."""
    from app.models import next_recurrence

    inexistante = datetime(2026, 3, 22, 2, 30, tzinfo=PARIS).astimezone(timezone.utc)
    suivant, _ = next_recurrence(inexistante, None, "weekly", "Europe/Paris")
    local = suivant.astimezone(PARIS)
    assert local.date() == datetime(2026, 3, 29).date()
    assert local.hour == 3 and local.minute == 30   # décalée de l'heure sautée

    en_double = datetime(2026, 10, 18, 2, 30, tzinfo=PARIS).astimezone(timezone.utc)
    suivant2, _ = next_recurrence(en_double, None, "weekly", "Europe/Paris")
    local2 = suivant2.astimezone(PARIS)
    assert local2.date() == datetime(2026, 10, 25).date()
    assert local2.hour == 2 and local2.minute == 30  # la première des deux


def test_plage_recurrente_garde_sa_duree_locale_malgre_le_changement_dheure():
    from app.models import next_recurrence

    debut = datetime(2026, 3, 25, 10, 0, tzinfo=PARIS).astimezone(timezone.utc)
    fin = datetime(2026, 3, 25, 12, 30, tzinfo=PARIS).astimezone(timezone.utc)
    nd, nf = next_recurrence(debut, fin, "weekly", "Europe/Paris")
    assert nd.astimezone(PARIS).hour == 10
    assert nf.astimezone(PARIS).hour == 12 and nf.astimezone(PARIS).minute == 30


def test_fuseau_absent_ou_farfelu_retombe_sur_le_calcul_utc():
    """Aucun réglage, ou un nom de fuseau que ZoneInfo refuse : on garde le
    comportement d'avant (+7 × 24 h) plutôt que d'échouer."""
    t = token()
    for reglage in ({"timezone": None}, {"timezone": "Mars/Olympus_Mons"}):
        client.patch("/api/settings", json=reglage, headers=auth(t))
        depart = iso(days=2)
        n = client.post("/api/notes", json={"title": "x", "due_at": depart, "recur": "weekly"},
                        headers=auth(t)).json()
        r = client.patch(f"/api/tasks/note/{n['id']}", json={"done": True}, headers=auth(t))
        assert r.status_code == 200, r.text
        assert parse(r.json()["due_at"]) == parse(depart) + timedelta(days=7)
    client.patch("/api/settings", json={"timezone": None}, headers=auth(t))


def test_29_fevrier_annuel_retombe_sur_le_28():
    t = token()
    bissextile = datetime(2028, 2, 29, 8, 0, tzinfo=timezone.utc)
    n = client.post("/api/notes", json={"title": "rare", "due_at": bissextile.isoformat(),
                                        "recur": "yearly"}, headers=auth(t)).json()
    client.patch(f"/api/tasks/note/{n['id']}", json={"done": True}, headers=auth(t))
    relu = client.get(f"/api/notes/{n['id']}", headers=auth(t)).json()
    assert parse(relu["due_at"]) == datetime(2029, 2, 28, 8, 0, tzinfo=timezone.utc)
