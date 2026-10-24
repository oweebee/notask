"""Agendas Google affichés dans Calendritasks (lecture + gestion des RDV).

Indépendant de la synchro « notasks datées → agenda » (google_calendar.py,
interrupteur `calendar_enabled`) : ici on LIT les agendas choisis par
l'utilisateur et on crée/modifie/supprime leurs RDV, sans rien en faire des
notasks. Interrupteur propre : `GoogleAccount.calendars_view_enabled`.

Chiffrement : les RDV Google transitent EN CLAIR par le serveur (lus avec le
jeton Google de l'utilisateur), mais ne sont JAMAIS stockés en base — seule
la liste des identifiants d'agendas affichés l'est (`visible_calendars`).

Scopes : calendar.readonly (calendarList) + calendar.events (lecture/écriture
des événements de tous les agendas) déjà demandés par SCOPES — aucune
reconnexion nécessaire. Les événements créés par notask (propriété privée
notask=1) sont exclus : ils sont déjà affichés comme notasks."""

import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import httpx
from sqlmodel import Session

from app.google_calendar import CALENDAR_API, HTTP_TIMEOUT, _valid_access_token
from app.models import GoogleAccount

log = logging.getLogger("notask.google_overlay")

MAX_CALENDRIERS = 50
MAX_EVENEMENTS_PAR_AGENDA = 2500


class OverlayError(Exception):
    """Erreur à remonter telle quelle au client (message en français)."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _token(account: GoogleAccount, session: Session) -> str:
    token = _valid_access_token(account, session)
    if not token:
        raise OverlayError("Compte Google à reconnecter (Options).", 409)
    return token


def _liste_json(brut: Optional[str]) -> Optional[List[str]]:
    if not brut:
        return None
    try:
        val = json.loads(brut)
    except ValueError:
        return None
    return [str(x) for x in val if isinstance(x, str)] if isinstance(val, list) else None


def visibles(account: GoogleAccount) -> Optional[List[str]]:
    """None = jamais réglé (on prend alors les agendas cochés côté Google)."""
    return _liste_json(account.visible_calendars)


def disponibles(account: GoogleAccount) -> Optional[List[str]]:
    """None = jamais réglé (tous les agendas proposés)."""
    return _liste_json(account.available_calendars)


def depuis(account: GoogleAccount) -> Dict[str, str]:
    try:
        val = json.loads(account.agenda_depuis or "{}")
    except ValueError:
        return {}
    return val if isinstance(val, dict) else {}


def pour_echeances(account: GoogleAccount) -> Optional[List[str]]:
    """None = jamais réglé (on prend alors les agendas affichés)."""
    return _liste_json(account.agenda_calendars)


def lister_agendas(account: GoogleAccount, session: Session) -> List[Dict[str, Any]]:
    token = _token(account, session)
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            resp = client.get(
                f"{CALENDAR_API}/users/me/calendarList",
                headers={"Authorization": f"Bearer {token}"},
                params={"showHidden": "false", "maxResults": "250"},
            )
            if resp.status_code == 403:
                raise OverlayError("Lecture des agendas refusée par Google : reconnectez le compte.", 409)
            resp.raise_for_status()
            items = resp.json().get("items", [])
    except httpx.HTTPError:
        log.exception("Échec listage agendas (overlay)")
        raise OverlayError("Google injoignable pour le moment.", 502)

    choix = visibles(account)
    echeances = pour_echeances(account)
    dispo = disponibles(account)
    out = []
    for it in items[:MAX_CALENDRIERS]:
        cid = it.get("id")
        if not cid:
            continue
        out.append({
            "id": cid,
            "summary": it.get("summaryOverride") or it.get("summary") or cid,
            "color": it.get("backgroundColor") or "#4285f4",
            "access_role": it.get("accessRole") or "reader",
            "writable": it.get("accessRole") in ("owner", "writer"),
            "primary": bool(it.get("primary")),
            "visible": (cid in choix) if choix is not None else bool(it.get("selected") or it.get("primary")),
        })
        out[-1]["in_agenda"] = (cid in echeances) if echeances is not None else out[-1]["visible"]
        out[-1]["available"] = (cid in dispo) if dispo is not None else True
        out[-1]["agenda_since"] = depuis(account).get(cid)
    out.sort(key=lambda c: (not c["primary"], c["summary"].lower()))
    # Agenda VIRTUEL « Anniversaires » : les événements eventType "birthday"
    # (générés par Google Contacts) vivent dans l'agenda principal ; on les
    # sépare pour pouvoir les afficher / masquer / compter en échéances à
    # part. Réglages dans les mêmes listes JSON ; clé absente = hérite de
    # l'agenda principal, "!id" = explicitement décoché (voir _drapeau).
    for parent in [c for c in out if c["primary"]]:
        vid = parent["id"] + VIRTUEL_ANNIV
        out.insert(out.index(parent) + 1, {
            "id": vid, "virtual_of": parent["id"], "summary": "Anniversaires",
            "color": "#e67c73", "access_role": "reader", "writable": False, "primary": False,
            "visible": _drapeau(choix, vid, parent["visible"]),
            "in_agenda": _drapeau(echeances, vid, parent["in_agenda"]),
            "available": _drapeau(dispo, vid, parent["available"]),
            "agenda_since": depuis(account).get(vid) or parent["agenda_since"],
        })
    return out


VIRTUEL_ANNIV = "#anniversaires"


def _drapeau(liste: Optional[List[str]], vid: str, defaut: bool) -> bool:
    if liste is None:
        return defaut
    if vid in liste:
        return True
    if "!" + vid in liste:
        return False
    return defaut


def _couleurs_evenements(client: httpx.Client, token: str) -> Dict[str, str]:
    try:
        resp = client.get(f"{CALENDAR_API}/colors", headers={"Authorization": f"Bearer {token}"})
        resp.raise_for_status()
        return {k: v.get("background") for k, v in resp.json().get("event", {}).items()}
    except httpx.HTTPError:
        return {}


def _normaliser(ev: Dict[str, Any], cal: Dict[str, Any], couleurs: Dict[str, str]) -> Optional[Dict[str, Any]]:
    if ev.get("status") == "cancelled":
        return None
    prive = (ev.get("extendedProperties") or {}).get("private") or {}
    if prive.get("notask") == "1":
        return None  # déjà affiché comme notask
    debut, fin = ev.get("start") or {}, ev.get("end") or {}
    all_day = "date" in debut
    if all_day:
        d1 = debut.get("date")
        # Google : date de fin EXCLUSIVE → inclusive côté client.
        try:
            d2 = (date.fromisoformat(fin.get("date")) - timedelta(days=1)).isoformat()
        except (TypeError, ValueError):
            d2 = d1
        start, end = d1, max(d1, d2)
    else:
        start, end = debut.get("dateTime"), fin.get("dateTime") or debut.get("dateTime")
        if not start:
            return None
    return {
        "id": ev.get("id"),
        "calendar_id": cal["id"],
        "calendar_summary": cal["summary"],
        "color": couleurs.get(ev.get("colorId")) or cal["color"],
        "summary": ev.get("summary") or "",
        "description": ev.get("description") or "",
        "location": ev.get("location") or "",
        "all_day": all_day,
        "start": start,
        "end": end,
        # Anniversaires (eventType "birthday", issus de Google Contacts) :
        # Google refuse modification ET suppression via l'API (constaté :
        # 400 « Attempt made to modify 'birthday' event… ») → lecture seule.
        "editable": cal["writable"] and not ev.get("locked", False) and ev.get("eventType") != "birthday",
        "event_type": ev.get("eventType") or "default",
        "source_host": "calendar.google.com",   # icône de provenance (favicon officiel)
        "recurring_event_id": ev.get("recurringEventId"),
        "html_link": ev.get("htmlLink"),
    }


def lister_evenements(account: GoogleAccount, session: Session, debut: datetime, fin: datetime,
                      pour_agenda: bool = False) -> Dict[str, Any]:
    """pour_agenda : agendas cochés « échéances » (colonne de droite) au
    lieu des agendas affichés dans Calendritasks."""
    agendas = lister_agendas(account, session)
    token = _token(account, session)
    evenements: List[Dict[str, Any]] = []
    erreurs: List[str] = []
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        couleurs = _couleurs_evenements(client, token)
        voulu = (lambda c: c["in_agenda"]) if pour_agenda else (lambda c: c["available"] and c["visible"])
        virtuels = {c["virtual_of"]: c for c in agendas if c.get("virtual_of")}
        for cal in agendas:
            if cal.get("virtual_of"):
                continue
            anniv = virtuels.get(cal["id"])
            if not voulu(cal) and not (anniv and voulu(anniv)):
                continue
            try:
                resp = client.get(
                    f"{CALENDAR_API}/calendars/{quote(cal['id'], safe='')}/events",
                    headers={"Authorization": f"Bearer {token}"},
                    params={
                        "timeMin": debut.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "timeMax": fin.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "singleEvents": "true",
                        "orderBy": "startTime",
                        "maxResults": str(MAX_EVENEMENTS_PAR_AGENDA),
                    },
                )
                resp.raise_for_status()
                for ev in resp.json().get("items", []):
                    cible = anniv if anniv and ev.get("eventType") == "birthday" else cal
                    if not voulu(cible):
                        continue
                    n = _normaliser(ev, cible, couleurs)
                    if n:
                        evenements.append(n)
            except httpx.HTTPError:
                log.exception("Échec lecture agenda %s (overlay)", cal["id"])
                erreurs.append(cal["summary"])
    return {"enabled": True, "calendars": agendas, "events": evenements, "errors": erreurs}


def _corps(data: Dict[str, Any]) -> Dict[str, Any]:
    """Champs client → corps Google. Seuls les champs présents sont envoyés
    (PATCH partiel)."""
    body: Dict[str, Any] = {}
    for k in ("summary", "description", "location"):
        if k in data and data[k] is not None:
            body[k] = data[k]
    if "start" in data and "end" in data:
        if data.get("all_day"):
            try:
                d1 = date.fromisoformat(str(data["start"])[:10])
                d2 = date.fromisoformat(str(data["end"])[:10])
            except ValueError:
                raise OverlayError("Date invalide.")
            if d2 < d1:
                raise OverlayError("La fin précède le début.")
            body["start"] = {"date": d1.isoformat(), "dateTime": None}
            body["end"] = {"date": (d2 + timedelta(days=1)).isoformat(), "dateTime": None}
        else:
            try:
                t1 = datetime.fromisoformat(str(data["start"]).replace("Z", "+00:00"))
                t2 = datetime.fromisoformat(str(data["end"]).replace("Z", "+00:00"))
            except ValueError:
                raise OverlayError("Heure invalide.")
            if t1.tzinfo is None or t2.tzinfo is None:
                raise OverlayError("Heure sans fuseau.")
            if t2 < t1:
                raise OverlayError("La fin précède le début.")
            body["start"] = {"dateTime": t1.isoformat(), "date": None}
            body["end"] = {"dateTime": t2.isoformat(), "date": None}
    return body


def _url(calendar_id: str, event_id: str = "") -> str:
    base = f"{CALENDAR_API}/calendars/{quote(calendar_id, safe='')}/events"
    return base + (f"/{quote(event_id, safe='')}" if event_id else "")


def _envoyer(account: GoogleAccount, session: Session, methode: str, url: str, body: Optional[Dict[str, Any]] = None):
    token = _token(account, session)
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            resp = client.request(methode, url, headers={"Authorization": f"Bearer {token}"}, json=body)
    except httpx.HTTPError:
        log.exception("Échec %s événement (overlay)", methode)
        raise OverlayError("Google injoignable pour le moment.", 502)
    if methode == "DELETE" and resp.status_code in (404, 410):
        return None
    if resp.status_code == 403:
        raise OverlayError("Google refuse la modification (agenda en lecture seule ?).", 403)
    if resp.status_code in (404, 410):
        raise OverlayError("RDV introuvable côté Google.", 404)
    if resp.status_code >= 400:
        log.error("Google %s %s → %s %s", methode, url, resp.status_code, resp.text[:300])
        # Message de Google renvoyé tel quel : seul moyen de savoir POURQUOI
        # sans aller lire les journaux du serveur.
        try:
            detail = resp.json().get("error", {}).get("message") or ""
        except ValueError:
            detail = ""
        raise OverlayError(f"Google a refusé la demande ({resp.status_code}){' : ' + detail if detail else '.'}", 502)
    return resp.json() if resp.content else None


def creer(account: GoogleAccount, session: Session, calendar_id: str, data: Dict[str, Any]) -> None:
    body = _corps(data)
    if "start" not in body:
        raise OverlayError("Début et fin obligatoires.")
    _envoyer(account, session, "POST", _url(calendar_id), body)


def modifier(account: GoogleAccount, session: Session, calendar_id: str, event_id: str, data: Dict[str, Any]) -> None:
    _envoyer(account, session, "PATCH", _url(calendar_id, event_id), _corps(data))


def supprimer(account: GoogleAccount, session: Session, calendar_id: str, event_id: str) -> None:
    _envoyer(account, session, "DELETE", _url(calendar_id, event_id))


def series_exclues(account: Optional[GoogleAccount]) -> set:
    if account is None or not account.series_exclues:
        return set()
    try:
        val = json.loads(account.series_exclues)
    except ValueError:
        return set()
    return {(str(a), str(b)) for a, b in val if isinstance(val, list)} if isinstance(val, list) else set()


def evenements_d_un_agenda(account: GoogleAccount, session: Session, cal_id: str,
                          debut: datetime, fin: datetime) -> List[Dict[str, Any]]:
    """Tous les RDV d'UN agenda Google (ou du virtuel Anniversaires), quels
    que soient ses réglages d'affichage — pour la fenêtre des séries."""
    agendas = lister_agendas(account, session)
    cible = next((c for c in agendas if c["id"] == cal_id), None)
    if cible is None:
        raise OverlayError("Agenda introuvable.", 404)
    reel = next((c for c in agendas if c["id"] == cible.get("virtual_of")), cible)
    a_virtuel = any(c.get("virtual_of") == reel["id"] for c in agendas)
    token = _token(account, session)
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.get(
            f"{CALENDAR_API}/calendars/{quote(reel['id'], safe='')}/events",
            headers={"Authorization": f"Bearer {token}"},
            params={
                "timeMin": debut.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                "timeMax": fin.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                "singleEvents": "true", "orderBy": "startTime",
                "maxResults": str(MAX_EVENEMENTS_PAR_AGENDA),
            },
        )
        if resp.status_code >= 400:
            raise OverlayError("Google a refusé la lecture de cet agenda.", 502)
    out = []
    for ev in resp.json().get("items", []):
        anniv = ev.get("eventType") == "birthday"
        if cible.get("virtual_of") and not anniv:
            continue
        if not cible.get("virtual_of") and anniv and a_virtuel:
            continue
        n = _normaliser(ev, cible, {})
        if n:
            out.append(n)
    return out


_JOURS = {"MO": "lundi", "TU": "mardi", "WE": "mercredi", "TH": "jeudi", "FR": "vendredi", "SA": "samedi", "SU": "dimanche"}
_MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]


def decrire_rrule(rrule: Optional[str]) -> str:
    """« RRULE:FREQ=WEEKLY;BYDAY=TU » → « chaque semaine (mardi), sans fin »."""
    if not rrule:
        return ""
    corps = rrule.split(":", 1)[1] if rrule.upper().startswith("RRULE:") else rrule
    p = dict(kv.split("=", 1) for kv in corps.split(";") if "=" in kv)
    freq = p.get("FREQ", "").upper()
    try:
        n = int(p.get("INTERVAL", "1"))
    except ValueError:
        n = 1
    unites = {"DAILY": ("jour", "jours"), "WEEKLY": ("semaine", "semaines"),
              "MONTHLY": ("mois", "mois"), "YEARLY": ("année", "ans")}
    if freq not in unites:
        return "récurrent"
    un, plusieurs = unites[freq]
    txt = (f"chaque {un}" if freq != "YEARLY" else "chaque année") if n == 1 else f"tous les {n} {plusieurs}"
    if freq == "WEEKLY" and n > 1:
        txt = f"toutes les {n} semaines"
    jours = [_JOURS.get(j[-2:].upper(), "") for j in p.get("BYDAY", "").split(",") if j]
    jours = [j for j in jours if j]
    if jours and freq in ("WEEKLY", "DAILY"):
        txt += f" ({', '.join(jours)})"
    if "UNTIL" in p:
        u = p["UNTIL"][:8]
        try:
            txt += f", jusqu'au {int(u[6:8])} {_MOIS[int(u[4:6]) - 1]} {u[:4]}"
        except (ValueError, IndexError):
            txt += ", avec date de fin"
    elif "COUNT" in p:
        txt += f", {p['COUNT']} fois"
    else:
        txt += ", sans fin"
    return txt


def regles_series(account: GoogleAccount, session: Session, cal_id: str, ids: List[str]) -> Dict[str, str]:
    """Règle de répétition de chaque série (événement maître), une requête
    par série. Agenda virtuel → agenda principal réel."""
    reel = cal_id[: -len(VIRTUEL_ANNIV)] if cal_id.endswith(VIRTUEL_ANNIV) else cal_id
    token = _token(account, session)
    out: Dict[str, str] = {}
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        for sid in ids[:60]:
            try:
                resp = client.get(_url(reel, sid), headers={"Authorization": f"Bearer {token}"})
                if resp.status_code < 400:
                    regle = next((r for r in resp.json().get("recurrence", []) if r.upper().startswith("RRULE")), None)
                    if regle:
                        out[sid] = regle
            except httpx.HTTPError:
                continue
    return out
