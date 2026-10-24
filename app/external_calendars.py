"""Agendas externes en lecture seule (abonnements iCal / ICS).

Couvre tout ce qui publie un flux .ics : adresse secrète iCal d'un agenda
Google (y compris d'un autre compte), calendrier publié Outlook / Microsoft
365, iCloud public (webcal://), calendriers de sport, scolaires, etc.

Sécurité : le serveur télécharge une URL fournie par l'utilisateur. Pour ne
pas en faire un relais vers le réseau interne (SSRF), seules les adresses
http(s) résolues vers des IP PUBLIQUES sont acceptées, redirections
vérifiées une à une, taille et durée bornées.

Les événements ne sont jamais stockés : cache mémoire de quelques minutes par
URL (un téléchargement par rendu de Calendritasks serait trop lent)."""

import ipaddress
import logging
import socket
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlsplit
from zoneinfo import ZoneInfo

import httpx

log = logging.getLogger("notask.external_calendars")

TAILLE_MAX = 5 * 1024 * 1024
DELAI = 15.0
CACHE_SECONDES = 600
MAX_PAR_UTILISATEUR = 20
MAX_EVENEMENTS = 3000

_cache: Dict[str, Tuple[float, bytes]] = {}


class ExterneErreur(Exception):
    pass


def normaliser_url(url: str) -> str:
    url = url.strip()
    if url.lower().startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ExterneErreur("Adresse invalide : http(s):// ou webcal:// attendu.")
    return url


def _verifier_hote(url: str) -> None:
    hote = urlsplit(url).hostname or ""
    try:
        infos = socket.getaddrinfo(hote, None)
    except socket.gaierror:
        raise ExterneErreur("Serveur introuvable.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ExterneErreur("Adresse refusée (réseau privé).")


def telecharger(url: str, force: bool = False) -> bytes:
    url = normaliser_url(url)
    maintenant = time.monotonic()
    if not force and url in _cache and maintenant - _cache[url][0] < CACHE_SECONDES:
        return _cache[url][1]
    courant = url
    with httpx.Client(timeout=DELAI, follow_redirects=False,
                      headers={"User-Agent": "notask-calendar/1.0", "Accept": "text/calendar, */*"}) as client:
        for _ in range(4):
            _verifier_hote(courant)
            try:
                with client.stream("GET", courant) as resp:
                    if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get("location"):
                        courant = normaliser_url(urljoin(courant, resp.headers["location"]))
                        continue
                    if resp.status_code >= 400:
                        raise ExterneErreur(f"Le serveur de l'agenda répond {resp.status_code}.")
                    morceaux, total = [], 0
                    for bloc in resp.iter_bytes():
                        total += len(bloc)
                        if total > TAILLE_MAX:
                            raise ExterneErreur("Agenda trop volumineux (5 Mo max).")
                        morceaux.append(bloc)
                    contenu = b"".join(morceaux)
                    _cache[url] = (maintenant, contenu)
                    return contenu
            except httpx.HTTPError:
                raise ExterneErreur("Agenda injoignable.")
    raise ExterneErreur("Trop de redirections.")


def _analyser(contenu: bytes):
    import icalendar
    import x_wr_timezone
    try:
        cal = icalendar.Calendar.from_ical(contenu)
    except Exception:
        raise ExterneErreur("Ce lien ne renvoie pas un agenda iCal (.ics) valide.")
    return x_wr_timezone.to_standard(cal)


def valider(url: str) -> None:
    """Télécharge et analyse une fois (à l'ajout)."""
    _analyser(telecharger(url, force=True))


def _en_aware(v: datetime, fuseau: Optional[str]) -> datetime:
    if v.tzinfo is not None:
        return v
    try:
        return v.replace(tzinfo=ZoneInfo(fuseau)) if fuseau else v.replace(tzinfo=timezone.utc)
    except Exception:
        return v.replace(tzinfo=timezone.utc)


def evenements(ext, debut: datetime, fin: datetime, fuseau: Optional[str]) -> List[Dict[str, Any]]:
    """Événements de l'agenda `ext` (ExternalCalendar) sur [debut, fin),
    récurrences dépliées, au format de google_overlay._normaliser."""
    import recurring_ical_events
    cal = _analyser(telecharger(ext.url))
    # Séries : UID des VEVENT sources portant une règle de répétition (les
    # instances dépliées portent toutes un RECURRENCE-ID, même uniques).
    series = {str(c.get("UID", "")) for c in cal.walk("VEVENT") if c.get("RRULE") is not None or c.get("RDATE") is not None}
    regles = {str(c.get("UID", "")): "RRULE:" + c.get("RRULE").to_ical().decode()
              for c in cal.walk("VEVENT") if c.get("RRULE") is not None}
    out: List[Dict[str, Any]] = []
    for ev in recurring_ical_events.of(cal).between(debut, fin):
        if len(out) >= MAX_EVENEMENTS:
            break
        if str(ev.get("STATUS", "")).upper() == "CANCELLED":
            continue
        d1 = ev.get("DTSTART")
        if d1 is None:
            continue
        d1 = d1.dt
        d2 = ev.get("DTEND")
        d2 = d2.dt if d2 is not None else None
        if d2 is None and ev.get("DURATION") is not None:
            d2 = d1 + ev.get("DURATION").dt
        all_day = isinstance(d1, date) and not isinstance(d1, datetime)
        if all_day:
            fin_incl = (d2 - timedelta(days=1)) if isinstance(d2, date) and not isinstance(d2, datetime) and d2 > d1 else d1
            start, end = d1.isoformat(), fin_incl.isoformat()
        else:
            a = _en_aware(d1, fuseau)
            b = _en_aware(d2, fuseau) if isinstance(d2, datetime) else a + timedelta(minutes=30)
            start, end = a.astimezone(timezone.utc).isoformat(), b.astimezone(timezone.utc).isoformat()
        uid = str(ev.get("UID", "")) or f"{ext.id}-{len(out)}"
        out.append({
            "id": f"{uid}@{start}",
            "calendar_id": f"ics:{ext.id}",
            "calendar_summary": ext.name,
            "color": ext.color,
            "summary": str(ev.get("SUMMARY", "")),
            "description": str(ev.get("DESCRIPTION", "")),
            "location": str(ev.get("LOCATION", "")),
            "all_day": all_day,
            "start": start,
            "end": end,
            "editable": False,
            "recurring_event_id": uid if uid in series else None,
            "rrule": regles.get(uid),
            "html_link": None,
        })
    return out


def comme_agenda(ext) -> Dict[str, Any]:
    return {
        "id": f"ics:{ext.id}", "ext_id": ext.id, "external": True,
        "summary": ext.name, "color": ext.color, "access_role": "reader", "writable": False,
        "primary": False, "visible": ext.visible, "available": ext.available, "in_agenda": ext.in_agenda,
        "agenda_since": (ext.in_agenda_since.replace(tzinfo=timezone.utc).isoformat()
                         if ext.in_agenda_since and ext.in_agenda_since.tzinfo is None
                         else (ext.in_agenda_since.isoformat() if ext.in_agenda_since else None)),
        "url_host": urlsplit(ext.url).hostname or "",
    }
