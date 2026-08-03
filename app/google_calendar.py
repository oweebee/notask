"""Client Google Calendar (OAuth + API REST), appels HTTP directs via httpx.

Pas de bibliothèque officielle Google (google-api-python-client / google-auth) :
l'API OAuth + Calendar v3 est un simple REST/JSON, et ce projet garde
volontairement ses dépendances minimales (voir requirements.txt). Un appel
Google qui échoue ne doit JAMAIS faire échouer la sauvegarde d'une notask —
toutes les fonctions publiques de synchro (sync_note, sync_item, pull_changes)
avalent leurs propres exceptions et journalisent, plutôt que de laisser
remonter une erreur jusqu'au routeur.

Compromis de chiffrement (accepté explicitement par l'utilisateur, pas
supposé) : seuls le titre en clair (Note.calendar_title / NoteItem.
calendar_title) et la date (due_at, déjà en clair côté serveur avant même
cette fonctionnalité) transitent vers Google. Le reste (description,
contenu, pièces jointes, notasks sans échéance) n'est jamais touché ici.

Sens Google -> notask (voir pull_changes) : UNIQUEMENT la date peut revenir
mettre à jour due_at. Un changement de titre fait dans Google Calendar ne
peut PAS être répercuté sur `title` (chiffré, le serveur n'a pas la clé) —
seul le miroir en clair `calendar_title` est mis à jour, sans effet visible
pour l'utilisateur (jamais renvoyé par l'API, voir NoteOut). Une suppression
d'événement côté Google efface due_at/calendar_title/google_event_id, mais
ne supprime jamais la notask elle-même.
"""

import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

import httpx
from sqlmodel import Session, select

from app.models import GoogleAccount, GoogleAppConfig, Note, NoteItem, User, utcnow

log = logging.getLogger("notask.google_calendar")

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
CALENDAR_API = "https://www.googleapis.com/calendar/v3"

# calendar.events suffit à créer/modifier/supprimer les événements, y compris
# dans un agenda secondaire. calendar.readonly n'est demandé QUE pour lister
# les agendas de l'utilisateur (choix de l'agenda de destination dans Profil) :
# calendar.events ne donne pas accès à calendarList.list. Un compte connecté
# avant l'ajout de ce scope continue de fonctionner pour la synchro — seule la
# liste déroulante des agendas sera indisponible tant qu'il n'est pas reconnecté
# (l'écran Profil bascule alors sur une saisie manuelle de l'identifiant).
SCOPES = (
    "openid email"
    " https://www.googleapis.com/auth/calendar.events"
    " https://www.googleapis.com/auth/calendar.readonly"
)

# Marque tout événement créé par notask, pour ne jamais tirer (pull_changes)
# le reste de l'agenda Google de l'utilisateur — seuls les événements portant
# cette propriété privée sont demandés à l'API (privateExtendedProperty).
EXT_PROP_FILTER = "notask=1"

# Durée par défaut d'un événement créé depuis une échéance notask (qui n'a
# qu'un instant, pas une plage horaire) — 30 minutes, modifiable seulement
# côté Google après coup si besoin.
DEFAULT_DURATION = timedelta(minutes=30)

# Notification Google Calendar avant l'échéance, en minutes.
REMINDER_MINUTES = 15

HTTP_TIMEOUT = 10.0


def _client_config(session: Session):
    """Base d'abord (réglage admin, voir GoogleAppConfig/routers/google.py
    admin-config), variables d'environnement en repli — permet de configurer
    soit depuis l'écran admin, soit via Coolify, sans que l'un empêche
    l'autre (pratique en développement local, où les variables restent plus
    simples que de passer par l'UI)."""
    row = session.exec(select(GoogleAppConfig)).first()
    if row and row.client_id and row.client_secret:
        return row.client_id, row.client_secret
    return os.getenv("GOOGLE_CLIENT_ID"), os.getenv("GOOGLE_CLIENT_SECRET")


def is_configured(session: Session) -> bool:
    client_id, client_secret = _client_config(session)
    return bool(client_id and client_secret)


def config_status(session: Session) -> Dict[str, Any]:
    """Pour l'écran admin : d'où vient la configuration actuelle (jamais le
    secret lui-même, voir GoogleAdminConfigOut dans app/models.py)."""
    row = session.exec(select(GoogleAppConfig)).first()
    if row and row.client_id and row.client_secret:
        return {"client_id": row.client_id, "has_secret": True, "source": "database"}
    env_id = os.getenv("GOOGLE_CLIENT_ID")
    env_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    if env_id and env_secret:
        return {"client_id": env_id, "has_secret": True, "source": "environment"}
    return {"client_id": row.client_id if row else None, "has_secret": False, "source": "none"}


# ================================ OAuth ================================

def new_state_token() -> str:
    return secrets.token_urlsafe(32)


def build_authorize_url(redirect_uri: str, state: str, session: Session) -> str:
    client_id, _ = _client_config(session)
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",
        # "consent" force Google à renvoyer un refresh_token même si
        # l'utilisateur a déjà autorisé l'appli par le passé (sinon, à partir
        # de la 2e autorisation, Google ne renvoie souvent qu'un access_token).
        "prompt": "consent",
        "state": state,
        "include_granted_scopes": "true",
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


def exchange_code(code: str, redirect_uri: str, session: Session) -> Dict[str, Any]:
    client_id, client_secret = _client_config(session)
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.post(TOKEN_URL, data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        })
        resp.raise_for_status()
        return resp.json()


def fetch_email(access_token: str) -> Optional[str]:
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            resp = client.get(USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
            resp.raise_for_status()
            return resp.json().get("email")
    except httpx.HTTPError:
        log.exception("Échec récupération e-mail Google")
        return None


def _refresh_access_token(refresh_token: str, session: Session) -> Dict[str, Any]:
    client_id, client_secret = _client_config(session)
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.post(TOKEN_URL, data={
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
        })
        resp.raise_for_status()
        return resp.json()


def revoke(token: str) -> None:
    """Best-effort : la déconnexion locale (suppression de GoogleAccount)
    se fait dans tous les cas, que la révocation côté Google réussisse ou
    non (jeton déjà expiré, réseau indisponible...)."""
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            client.post(REVOKE_URL, data={"token": token})
    except httpx.HTTPError:
        log.exception("Échec révocation jeton Google (ignoré, déconnexion locale quand même)")


def _as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Rétablit l'étiquette UTC sur un datetime relu depuis SQLite.

    SQLite n'a pas de type datetime "avec fuseau" : SQLAlchemy réécrit bien
    la bonne valeur numérique, mais la relit NAÏVE (tzinfo perdu). Comparer
    un tel datetime naïf à un datetime conscient (utcnow(), qui renvoie
    datetime.now(timezone.utc)) lève `TypeError: can't compare offset-naive
    and offset-aware datetimes`. Ne déplace jamais l'heure, ne fait que
    remettre l'étiquette perdue. Même correctif que _due_at_utc() dans
    app/models.py, côté colonnes non exposées par l'API."""
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _valid_access_token(account: GoogleAccount, session: Session) -> Optional[str]:
    """Renvoie un jeton d'accès valide, en le rafraîchissant si besoin.
    Persiste le nouveau jeton (ou needs_reauth=True en cas d'échec) avant de
    renvoyer. None => le compte a besoin d'être reconnecté."""
    now = utcnow()
    # _as_utc indispensable ici : access_token_expires_at ressort naïf de
    # SQLite, et la comparaison brute avec `now` (conscient) levait un
    # TypeError. Ce TypeError était ensuite avalé par le `except Exception`
    # de sync_note()/sync_item() — d'où une synchro Google Calendar qui
    # échouait SILENCIEUSEMENT à chaque sauvegarde, sans jamais créer le
    # moindre événement ni remonter la moindre erreur à l'utilisateur.
    expires_at = _as_utc(account.access_token_expires_at)
    if account.access_token and expires_at and expires_at > now + timedelta(seconds=30):
        return account.access_token

    try:
        payload = _refresh_access_token(account.refresh_token, session)
    except httpx.HTTPStatusError as exc:
        # 400/401 typique d'un refresh_token révoqué ou expiré côté Google.
        if exc.response is not None and exc.response.status_code in (400, 401):
            account.needs_reauth = True
            session.add(account)
            session.commit()
        else:
            log.exception("Échec rafraîchissement jeton Google (temporaire)")
        return None
    except httpx.HTTPError:
        log.exception("Échec réseau rafraîchissement jeton Google")
        return None

    account.access_token = payload.get("access_token")
    expires_in = payload.get("expires_in", 3600)
    account.access_token_expires_at = now + timedelta(seconds=expires_in)
    account.needs_reauth = False
    session.add(account)
    session.commit()
    session.refresh(account)
    return account.access_token


# ============================== Événements ==============================

def _format_dt(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_dt(value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def remember_base_url(session: Session, base_url: str) -> None:
    """Mémorise l'adresse publique de l'installation si elle a changé.

    Appelée depuis les routeurs qui disposent d'un objet Request. La synchro
    (sync_note/sync_item) tourne sans contexte de requête et ne peut pas
    deviner cette adresse : sans ce relevé, le lien « Ouvrir dans notask »
    n'apparaîtrait qu'après une reconnexion Google. Écrit uniquement quand la
    valeur diffère, pour ne pas transformer chaque chargement de liste en
    écriture en base."""
    valeur = (base_url or "").rstrip("/")
    if not valeur:
        return
    try:
        row = session.exec(select(GoogleAppConfig)).first()
        if row is None:
            row = GoogleAppConfig()
        elif row.base_url == valeur:
            return
        row.base_url = valeur
        session.add(row)
        session.commit()
    except Exception:
        log.exception("Échec mémorisation de l'adresse publique")


def _app_base_url(session: Session) -> Optional[str]:
    """Adresse publique de l'installation, pour le lien de retour vers la
    notask. Variable d'environnement prioritaire (permet de forcer une
    valeur), sinon celle relevée automatiquement au moment de la connexion
    Google. None => aucun lien n'est ajouté, l'événement reste valide."""
    env = os.getenv("APP_BASE_URL")
    if env:
        return env.rstrip("/")
    row = session.exec(select(GoogleAppConfig)).first()
    if row and row.base_url:
        return row.base_url.rstrip("/")
    return None


def _event_body(title: str, due_at: datetime, kind: str, ref_id: int, note_id: int, session: Session,
                due_end_at: Optional[datetime] = None) -> Dict[str, Any]:
    start = due_at
    # Plage horaire explicite si une fin est posée ET postérieure au début.
    # Google refuse un événement dont la fin précède le début (400) : une
    # valeur incohérente (fin avancée avant le début côté client, ou
    # remontée telle quelle depuis un vieil enregistrement) doit retomber
    # sur la durée par défaut plutôt que faire échouer toute la synchro.
    # Comparaison via _as_utc : les deux dates ressortent naïves de SQLite,
    # les mélanger avec une valeur consciente lèverait un TypeError.
    debut_utc = _as_utc(due_at)
    fin_utc = _as_utc(due_end_at)
    if fin_utc is not None and debut_utc is not None and fin_utc > debut_utc:
        end = due_end_at
    else:
        end = due_at + DEFAULT_DURATION
    body: Dict[str, Any] = {
        "summary": title[:1000] or "(sans titre)",
        "start": {"dateTime": _format_dt(start)},
        "end": {"dateTime": _format_dt(end)},
        "extendedProperties": {
            "private": {"notask": "1", "notask_kind": kind, "notask_ref_id": str(ref_id)},
        },
        # Notification Google Calendar avant l'échéance. useDefault=False est
        # indispensable : sans lui, Google applique les rappels par défaut de
        # l'agenda et ignore purement et simplement `overrides`. Le rappel
        # vise TOUJOURS la notask elle-même (note_id), y compris pour une
        # ligne à cocher datée : c'est la notask qu'on veut ouvrir.
        "reminders": {
            "useDefault": False,
            "overrides": [{"method": "popup", "minutes": REMINDER_MINUTES}],
        },
    }

    base = _app_base_url(session)
    if base:
        # `note_id` et PAS `ref_id` : pour une ligne à cocher datée, ref_id
        # est l'identifiant de la ligne, qui n'a pas d'écran à elle — le lien
        # doit ouvrir la notask qui la contient.
        body["description"] = f"Ouvrir dans notask : {base}/?notask={note_id}"
    return body


def _events_url(account: GoogleAccount, suffix: str = "") -> str:
    from urllib.parse import quote
    return f"{CALENDAR_API}/calendars/{quote(account.calendar_id, safe='')}/events{suffix}"


def create_event(account: GoogleAccount, session: Session, title: str, due_at: datetime, kind: str, ref_id: int, note_id: int, due_end_at: Optional[datetime] = None) -> Optional[str]:
    token = _valid_access_token(account, session)
    if not token:
        return None
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            resp = client.post(
                _events_url(account),
                headers={"Authorization": f"Bearer {token}"},
                json=_event_body(title, due_at, kind, ref_id, note_id, session, due_end_at),
            )
            resp.raise_for_status()
            return resp.json().get("id")
    except httpx.HTTPError:
        log.exception("Échec création événement Google Calendar")
        return None


def update_event(account: GoogleAccount, session: Session, event_id: str, title: str, due_at: datetime, kind: str, ref_id: int, note_id: int, due_end_at: Optional[datetime] = None) -> str:
    """Renvoie "ok", "gone" (404/410 confirmé — l'appelant peut recréer sans
    risque de doublon) ou "error" (échec réseau/temporaire — NE PAS recréer :
    l'événement existe peut-être toujours côté Google, en recréer un
    produirait un doublon ; on retentera la mise à jour au prochain appel,
    google_event_id reste inchangé)."""
    token = _valid_access_token(account, session)
    if not token:
        return "error"
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            resp = client.patch(
                _events_url(account, f"/{event_id}"),
                headers={"Authorization": f"Bearer {token}"},
                json=_event_body(title, due_at, kind, ref_id, note_id, session, due_end_at),
            )
            if resp.status_code in (404, 410):
                return "gone"
            resp.raise_for_status()
            return "ok"
    except httpx.HTTPError:
        log.exception("Échec mise à jour événement Google Calendar")
        return "error"


def delete_event(account: GoogleAccount, session: Session, event_id: str) -> bool:
    token = _valid_access_token(account, session)
    if not token:
        return False
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            resp = client.delete(
                _events_url(account, f"/{event_id}"),
                headers={"Authorization": f"Bearer {token}"},
            )
            # 404/410 : déjà supprimé côté Google, considéré comme un succès.
            if resp.status_code not in (200, 204, 404, 410):
                resp.raise_for_status()
            return True
    except httpx.HTTPError:
        log.exception("Échec suppression événement Google Calendar")
        return False


def list_calendars(account: GoogleAccount, session: Session) -> Dict[str, Any]:
    """Liste les agendas de l'utilisateur, pour choisir celui de destination.

    Renvoie {"calendars": [...], "error": None} ou {"calendars": [],
    "error": "..."} — jamais d'exception : l'écran Profil doit rester
    utilisable même si Google refuse (cas courant : compte connecté avant
    l'ajout du scope calendar.readonly, voir SCOPES). Seuls les agendas où
    l'utilisateur peut écrire sont renvoyés (accessRole owner/writer) : y
    proposer un agenda en lecture seule ne mènerait qu'à un échec à la
    première synchro."""
    token = _valid_access_token(account, session)
    if not token:
        return {"calendars": [], "error": "reauth"}
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            resp = client.get(
                f"{CALENDAR_API}/users/me/calendarList",
                headers={"Authorization": f"Bearer {token}"},
                params={"minAccessRole": "writer", "showHidden": "true"},
            )
            if resp.status_code == 403:
                return {"calendars": [], "error": "scope"}
            resp.raise_for_status()
            items = resp.json().get("items", [])
    except httpx.HTTPError:
        log.exception("Échec listage des agendas Google")
        return {"calendars": [], "error": "network"}

    return {
        "calendars": [
            {
                "id": it.get("id"),
                "summary": it.get("summary") or it.get("id"),
                "primary": bool(it.get("primary")),
            }
            for it in items
            if it.get("id")
        ],
        "error": None,
    }


def _list_changes_page(account: GoogleAccount, token: str, page_token: Optional[str], sync_token: Optional[str]) -> Dict[str, Any]:
    params = {"singleEvents": "true", "privateExtendedProperty": EXT_PROP_FILTER}
    if page_token:
        params["pageToken"] = page_token
    if sync_token:
        params["syncToken"] = sync_token
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.get(_events_url(account), headers={"Authorization": f"Bearer {token}"}, params=params)
        resp.raise_for_status()
        return resp.json()


def list_changes(account: GoogleAccount, session: Session) -> List[Dict[str, Any]]:
    """Tirage incrémental : renvoie les événements notask créés/modifiés/
    supprimés côté Google depuis le dernier appel (ou tous, la première
    fois). Met à jour et persiste account.sync_token. En cas de jeton de
    synchro invalide (410, calendrier réorganisé côté Google), repart d'une
    synchro complète silencieusement plutôt que de faire échouer l'appel."""
    token = _valid_access_token(account, session)
    if not token:
        return []

    events: List[Dict[str, Any]] = []
    page_token = None
    sync_token = account.sync_token
    try:
        while True:
            data = _list_changes_page(account, token, page_token, sync_token)
            events.extend(data.get("items", []))
            page_token = data.get("nextPageToken")
            if not page_token:
                next_sync_token = data.get("nextSyncToken")
                if next_sync_token:
                    account.sync_token = next_sync_token
                    session.add(account)
                    session.commit()
                break
    except httpx.HTTPStatusError as exc:
        if exc.response is not None and exc.response.status_code == 410:
            # Jeton de synchro périmé : on efface et on retentera une synchro
            # complète au prochain passage (paresseux, comme le reste de
            # cette appli — voir _purge_expired_trash dans routers/notes.py).
            account.sync_token = None
            session.add(account)
            session.commit()
            return []
        log.exception("Échec tirage Google Calendar")
        return []
    except httpx.HTTPError:
        log.exception("Échec réseau tirage Google Calendar")
        return []

    return events


# ========================= Synchro notask -> Google =========================

def _account_for(user_id: int, session: Session) -> Optional[GoogleAccount]:
    return session.exec(select(GoogleAccount).where(GoogleAccount.user_id == user_id)).first()


def sync_note(note: Note, session: Session) -> None:
    """À appeler après toute mutation d'une notask (création, mise à jour,
    suppression, restauration). N'échoue jamais bruyamment : un souci Google
    est journalisé, jamais remonté à l'appelant (la sauvegarde de la notask
    elle-même a déjà réussi et ne doit pas en dépendre)."""
    try:
        account = _account_for(note.user_id, session)
        if account is None:
            return
        should_have_event = (
            note.due_at is not None
            and not note.archived
            and note.trashed_at is None
            # Une tâche terminée disparaît de l'agenda : l'événement Google
            # est supprimé au passage en "terminé", et recréé si on la
            # décoche (set_done rappelle sync_note dans les deux sens).
            and not note.done
            # `is not None`, PAS une simple vérité (bool(...)) : une notask
            # sans titre envoie calendar_title="" (chaîne vide, jamais None
            # tant que due_at est posée — voir #nc-add dans app.js), et
            # bool("") vaut False en Python. Avec un simple bool(...), une
            # notask datée mais sans titre ne synchronisait jamais — bug
            # trouvé après un signalement ("je ne vois pas ma notask dans
            # Google Calendar" sur une note sans titre). _event_body()
            # affiche déjà "(sans titre)" pour ce cas, la synchro doit donc
            # avoir lieu.
            and note.calendar_title is not None
        )
        changed = False
        if should_have_event:
            if note.google_event_id:
                result = update_event(account, session, note.google_event_id, note.calendar_title, note.due_at, "note", note.id, note.id, note.due_end_at)
                if result == "gone":
                    # Confirmé supprimé côté Google (404/410) : sûr de
                    # recréer, aucun risque de doublon.
                    note.google_event_id = create_event(account, session, note.calendar_title, note.due_at, "note", note.id, note.id, note.due_end_at)
                    changed = True
                # "error" (réseau/temporaire) : on ne touche à rien, l'ancien
                # google_event_id reste en place, retenté au prochain appel —
                # recréer ici pourrait produire un doublon si l'événement
                # existe toujours côté Google malgré l'échec de la requête.
            else:
                note.google_event_id = create_event(account, session, note.calendar_title, note.due_at, "note", note.id, note.id, note.due_end_at)
                changed = True
        elif note.google_event_id:
            # google_event_id n'est effacé que si la suppression a
            # réellement réussi (ou l'événement était déjà absent côté
            # Google) — sinon on garde la référence pour retenter au
            # prochain appel, plutôt que de perdre la trace d'un événement
            # peut-être encore bien présent sur Google (orphelin qu'on ne
            # pourrait alors plus jamais retrouver ni supprimer).
            if delete_event(account, session, note.google_event_id):
                note.google_event_id = None
                changed = True
        if changed:
            session.add(note)
            session.commit()
            session.refresh(note)
    except Exception:
        log.exception("Échec synchro Google Calendar (notask %s)", note.id)


def sync_item(item: NoteItem, note: Note, session: Session) -> None:
    """Même principe que sync_note, à l'échelle d'une ligne à cocher datée.
    `note` doit être la notask parente déjà chargée (pour connaître
    user_id/archived/trashed_at), pas rechargée ici pour éviter un aller-
    retour supplémentaire en base à chaque appel."""
    try:
        account = _account_for(note.user_id, session)
        if account is None:
            return
        should_have_event = (
            item.due_at is not None
            and not note.archived
            and note.trashed_at is None
            # cf. sync_note : une ligne cochée disparaît de l'agenda.
            and not item.checked
            # cf. sync_note : `is not None`, pas bool(...).
            and item.calendar_title is not None
        )
        changed = False
        if should_have_event:
            if item.google_event_id:
                result = update_event(account, session, item.google_event_id, item.calendar_title, item.due_at, "item", item.id, note.id, item.due_end_at)
                if result == "gone":
                    item.google_event_id = create_event(account, session, item.calendar_title, item.due_at, "item", item.id, note.id, item.due_end_at)
                    changed = True
                # cf. sync_note : "error" ne déclenche jamais de recréation.
            else:
                item.google_event_id = create_event(account, session, item.calendar_title, item.due_at, "item", item.id, note.id, item.due_end_at)
                changed = True
        elif item.google_event_id:
            # cf. sync_note : google_event_id conservé si la suppression échoue.
            if delete_event(account, session, item.google_event_id):
                item.google_event_id = None
                changed = True
        if changed:
            session.add(item)
            session.commit()
            session.refresh(item)
    except Exception:
        log.exception("Échec synchro Google Calendar (ligne %s)", item.id)


def change_calendar(account: GoogleAccount, new_calendar_id: str, session: Session) -> Dict[str, Any]:
    """Change l'agenda de destination et y redéplace les événements existants.

    Un événement Google appartient à UN agenda : changer `calendar_id` sans
    rien faire d'autre laisserait tous les événements déjà créés dans
    l'ancien agenda, définitivement orphelins (plus aucune notask ne
    pointerait dessus pour les mettre à jour ou les supprimer). On les
    supprime donc de l'ANCIEN agenda AVANT de basculer, puis on laisse
    sync_note()/sync_item() les recréer dans le nouveau.

    L'ordre importe : delete_event() utilise account.calendar_id, la
    suppression doit donc avoir lieu tant qu'il vaut encore l'ancien.
    Renvoie un petit compte rendu (déplacés / non supprimés) plutôt que de
    lever : un échec de nettoyage ne doit pas empêcher le changement."""
    ancien = account.calendar_id
    resultat = {"moved": 0, "orphans": 0}
    if new_calendar_id == ancien:
        return resultat

    notes = session.exec(
        select(Note).where(Note.user_id == account.user_id, Note.google_event_id.is_not(None))
    ).all()
    items = session.exec(
        select(NoteItem)
        .join(Note, NoteItem.note_id == Note.id)
        .where(Note.user_id == account.user_id, NoteItem.google_event_id.is_not(None))
    ).all()

    for objet in [*notes, *items]:
        if delete_event(account, session, objet.google_event_id):
            resultat["moved"] += 1
        else:
            # Suppression impossible (réseau, droits...) : l'événement reste
            # peut-être dans l'ancien agenda. On oublie quand même la
            # référence, sinon la notask resterait accrochée à un agenda
            # qu'elle n'utilise plus et ne serait jamais recréée dans le
            # nouveau — un orphelin visible vaut mieux qu'une notask muette.
            resultat["orphans"] += 1
        objet.google_event_id = None
        session.add(objet)

    account.calendar_id = new_calendar_id
    # Le jeton de synchro incrémentale est propre à un agenda : le garder
    # ferait tirer des changements de l'ancien. On repart d'une synchro
    # complète sur le nouvel agenda.
    account.sync_token = None
    account.updated_at = utcnow()
    session.add(account)
    session.commit()

    # Recréation dans le nouvel agenda (chaque appel avale ses propres
    # erreurs, cf. sync_note/sync_item).
    for note in notes:
        session.refresh(note)
        sync_note(note, session)
    for item in items:
        session.refresh(item)
        note = session.get(Note, item.note_id)
        if note is not None:
            sync_item(item, note, session)

    return resultat


def _periode_depuis_evenement(event: Dict[str, Any], debut: Optional[datetime]) -> Optional[datetime]:
    """Fin de plage à retenir pour un événement tiré depuis Google.

    Tout événement Google a une fin, y compris ceux que notask a créés sans
    plage (fin = début + DEFAULT_DURATION). La recopier telle quelle
    transformerait chaque simple échéance en période dès le premier tirage.
    On ne retient donc une fin que si la durée diffère de la durée par
    défaut — ce qui signifie que l'utilisateur l'a réellement modifiée dans
    Google Calendar (ou qu'elle vient d'une plage posée depuis notask).
    """
    if debut is None:
        return None
    fin_brute = (event.get("end") or {}).get("dateTime")
    fin = _parse_dt(fin_brute) if fin_brute else None
    if fin is None:
        return None
    debut_utc, fin_utc = _as_utc(debut), _as_utc(fin)
    if debut_utc is None or fin_utc is None or fin_utc <= debut_utc:
        return None
    return None if (fin_utc - debut_utc) == DEFAULT_DURATION else fin


# ========================= Synchro Google -> notask =========================

def pull_changes(user: User, session: Session) -> None:
    """Tirage paresseux, appelé en tête de list_notes() (même schéma que
    _purge_expired_trash) : au pire, un changement fait côté Google Calendar
    met un chargement de plus à apparaître dans notask, jamais de tâche
    planifiée ni de webhook. Ne répercute QUE la date (due_at) — voir le
    commentaire en tête de fichier sur la limite de chiffrement."""
    try:
        account = _account_for(user.id, session)
        if account is None or account.needs_reauth:
            return
        changes = list_changes(account, session)
        if not changes:
            return

        for event in changes:
            event_id = event.get("id")
            if not event_id:
                continue
            cancelled = event.get("status") == "cancelled"

            note = session.exec(
                select(Note).where(Note.user_id == user.id, Note.google_event_id == event_id)
            ).first()
            if note is not None:
                if cancelled:
                    note.due_at = None
                    note.due_end_at = None
                    note.calendar_title = None
                    note.google_event_id = None
                    note.done = False
                    note.done_at = None
                else:
                    start = (event.get("start") or {}).get("dateTime")
                    parsed = _parse_dt(start) if start else None
                    if parsed:
                        note.due_at = parsed
                        note.due_end_at = _periode_depuis_evenement(event, parsed)
                    summary = event.get("summary")
                    if summary:
                        note.calendar_title = summary
                session.add(note)
                continue

            item = session.exec(
                select(NoteItem)
                .join(Note, NoteItem.note_id == Note.id)
                .where(Note.user_id == user.id, NoteItem.google_event_id == event_id)
            ).first()
            if item is not None:
                if cancelled:
                    item.due_at = None
                    item.due_end_at = None
                    item.calendar_title = None
                    item.google_event_id = None
                else:
                    start = (event.get("start") or {}).get("dateTime")
                    parsed = _parse_dt(start) if start else None
                    if parsed:
                        item.due_at = parsed
                        item.due_end_at = _periode_depuis_evenement(event, parsed)
                    summary = event.get("summary")
                    if summary:
                        item.calendar_title = summary
                session.add(item)

        session.commit()
    except Exception:
        log.exception("Échec tirage Google Calendar (utilisateur %s)", user.id)
