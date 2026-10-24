"""Agendas externes iCal/ICS (voir app/external_calendars.py)."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from app import external_calendars as ext
from app import google_calendar as gcal
from app.db import get_session
from app.deps import get_current_user
from datetime import timedelta

from app.models import (
    CalendarEventDone, CalendarEventDoneIn, ExternalCalendar, ExternalCalendarIn, ExternalCalendarUpdate,
    User, utcnow,
)

router = APIRouter(prefix="/api/calendars", tags=["calendars"])
CORBEILLE_JOURS = 30
CONSERVATION_JOURS = 120


def _a_moi(cal_id: int, user: User, session: Session) -> ExternalCalendar:
    row = session.get(ExternalCalendar, cal_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Agenda introuvable")
    return row


@router.get("/external")
def lister(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    rows = session.exec(select(ExternalCalendar).where(ExternalCalendar.user_id == user.id)).all()
    from app.models import GoogleAccount
    from app import google_overlay as gov
    compte = session.exec(select(GoogleAccount).where(GoogleAccount.user_id == user.id)).first()
    exclus = set(gov._liste_json(compte.recurrents_exclus) or []) if compte is not None else set()
    return [dict(ext.comme_agenda(r), agenda_recurrents=f"ics:{r.id}" not in exclus) for r in rows]


@router.post("/external", status_code=status.HTTP_201_CREATED)
def ajouter(payload: ExternalCalendarIn, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    n = len(session.exec(select(ExternalCalendar.id).where(ExternalCalendar.user_id == user.id)).all())
    if n >= ext.MAX_PAR_UTILISATEUR:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{ext.MAX_PAR_UTILISATEUR} agendas externes maximum.")
    try:
        url = ext.normaliser_url(payload.url)
        ext.valider(url)
    except ext.ExterneErreur as err:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(err))
    row = ExternalCalendar(user_id=user.id, name=payload.name.strip(), url=url, color=payload.color)
    session.add(row)
    session.commit()
    session.refresh(row)
    return ext.comme_agenda(row)


@router.patch("/external/{cal_id}")
def modifier(cal_id: int, payload: ExternalCalendarUpdate, user: User = Depends(get_current_user),
             session: Session = Depends(get_session)):
    row = _a_moi(cal_id, user, session)
    data = payload.model_dump(exclude_unset=True)
    if data.get("in_agenda") and not row.in_agenda:
        row.in_agenda_since = utcnow()
    for k, v in data.items():
        if v is not None:
            setattr(row, k, v.strip() if isinstance(v, str) and k == "name" else v)
    session.add(row)
    session.commit()
    session.refresh(row)
    return ext.comme_agenda(row)


@router.delete("/external/{cal_id}", status_code=status.HTTP_204_NO_CONTENT)
def supprimer(cal_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    row = _a_moi(cal_id, user, session)
    session.delete(row)
    session.commit()


# ---- RDV validés (corbeille notask, rien n'est touché à la source) ----

def purger_valides(user_id: int, session: Session) -> None:
    limite = utcnow() - timedelta(days=CONSERVATION_JOURS)
    for r in session.exec(select(CalendarEventDone).where(
            CalendarEventDone.user_id == user_id, CalendarEventDone.done_at < limite)).all():
        session.delete(r)
    session.commit()


@router.get("/done")
def lister_valides(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    """RDV validés encore dans la corbeille (30 jours, non effacés)."""
    purger_valides(user.id, session)
    limite = utcnow() - timedelta(days=CORBEILLE_JOURS)
    rows = session.exec(select(CalendarEventDone).where(
        CalendarEventDone.user_id == user.id,
        CalendarEventDone.hidden_from_trash == False,  # noqa: E712
        CalendarEventDone.done_at >= limite,
    ).order_by(CalendarEventDone.done_at.desc())).all()
    return [{"id": r.id, "calendar_id": r.calendar_id, "event_id": r.event_id, "start": r.start,
             "title_enc": r.title_enc, "done_at": r.done_at} for r in rows]


@router.post("/done", status_code=status.HTTP_201_CREATED)
def valider(payload: CalendarEventDoneIn, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    row = session.exec(select(CalendarEventDone).where(
        CalendarEventDone.user_id == user.id, CalendarEventDone.calendar_id == payload.calendar_id,
        CalendarEventDone.event_id == payload.event_id)).first()
    if row is None:
        row = CalendarEventDone(user_id=user.id, **payload.model_dump())
    else:
        row.done_at, row.hidden_from_trash, row.title_enc = utcnow(), False, payload.title_enc
    session.add(row)
    session.commit()
    session.refresh(row)
    return {"id": row.id}


@router.delete("/done/{done_id}", status_code=status.HTTP_204_NO_CONTENT)
def restaurer(done_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    """Restaurer = annuler la validation : le RDV revient dans les échéances."""
    row = session.get(CalendarEventDone, done_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "RDV introuvable")
    session.delete(row)
    session.commit()


@router.post("/done/{done_id}/hide", status_code=status.HTTP_204_NO_CONTENT)
def effacer_de_la_corbeille(done_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    """« Supprimer définitivement » : sort de la corbeille, reste validé."""
    row = session.get(CalendarEventDone, done_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "RDV introuvable")
    row.hidden_from_trash = True
    session.add(row)
    session.commit()


@router.post("/refresh")
def synchroniser(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    """Synchronisation forcée de tous les agendas connectés : agendas externes
    retéléchargés (cache vidé), tirage Google → notasks (dates modifiées dans
    Google, cf. gcal.pull_changes). Les RDV Google affichés ne sont jamais en
    cache serveur : le client les relit juste après."""
    erreurs = []
    rows = session.exec(select(ExternalCalendar).where(ExternalCalendar.user_id == user.id)).all()
    for r in rows:
        try:
            ext.telecharger(r.url, force=True)
        except ext.ExterneErreur as err:
            erreurs.append(f"{r.name} : {err}")
    gcal.pull_changes(user, session)
    return {"externes": len(rows), "errors": erreurs}


# ---- Échéances issues des agendas (pour l'app Android : widget + rappels) ----

def _cle_entiere(calendar_id: str, event_id: str) -> int:
    """Identifiant entier STABLE (l'app Android indexe ses tâches et ses
    alarmes par entier) : CRC32 de la clé texte, borné à 999 999 pour tenir
    dans la plage de requestCode réservée aux RDV (3 000 000 + n)."""
    import zlib
    return zlib.crc32(f"{calendar_id}\x00{event_id}".encode()) % 999_999 + 1


@router.get("/echeances")
def echeances_agendas(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    """RDV des agendas cochés « Échéances », au format proche de TaskOut
    (kind="gcal", texte EN CLAIR, `plain`: true). Même règles que la colonne
    d'échéances du web (agendaGoogle dans app.js) : 60 j passés → 31 j à venir,
    validés exclus, passés = « late » seulement s'ils finissent après la date
    d'activation de leur agenda. Jours calculés dans le fuseau déclaré."""
    from datetime import date as _date, datetime as _dt, timezone as _tz
    from zoneinfo import ZoneInfo
    from app.routers.google import overlay_evenements
    from app.routers.settings import fuseau_utilisateur

    maintenant = utcnow()
    if maintenant.tzinfo is None:
        maintenant = maintenant.replace(tzinfo=_tz.utc)
    r = overlay_evenements(
        start=(maintenant - timedelta(days=60)).isoformat(),
        end=(maintenant + timedelta(days=31)).isoformat(),
        pour="agenda", user=user, session=session,
    )
    if not r.get("enabled"):
        return []
    try:
        fz = ZoneInfo(fuseau_utilisateur(user.id, session) or "UTC")
    except Exception:
        fz = _tz.utc
    auj = maintenant.astimezone(fz).date()
    limite = auj + timedelta(days=7)
    depuis = {}
    for c in r.get("calendars", []):
        if c.get("agenda_since"):
            try:
                d = _dt.fromisoformat(c["agenda_since"].replace("Z", "+00:00"))
                depuis[c["id"]] = d if d.tzinfo else d.replace(tzinfo=_tz.utc)
            except ValueError:
                pass
    out = []
    for g in r.get("events", []):
        if g.get("done"):
            continue
        if g["all_day"]:
            j1 = _date.fromisoformat(g["start"])
            j2 = _date.fromisoformat(g["end"])
            debut = _dt(j1.year, j1.month, j1.day, tzinfo=_tz.utc)          # convention serveur : minuit UTC
            fin_excl = _dt(j2.year, j2.month, j2.day, tzinfo=fz) + timedelta(days=1)
            due_at, due_end = debut, (_dt(j2.year, j2.month, j2.day, tzinfo=_tz.utc) if j2 != j1 else None)
            jour = j1
        else:
            debut = _dt.fromisoformat(g["start"].replace("Z", "+00:00"))
            fin_excl = _dt.fromisoformat(g["end"].replace("Z", "+00:00"))
            due_at, due_end = debut, fin_excl
            jour = debut.astimezone(fz).date()
        if fin_excl <= maintenant:
            d = depuis.get(g["calendar_id"])
            if d is None or fin_excl <= d:
                continue
            bucket = "late"
        elif jour <= auj:
            bucket = "today"
        elif jour <= limite:
            bucket = "imminent"
        else:
            bucket = "upcoming"
        out.append({
            "kind": "gcal", "id": _cle_entiere(g["calendar_id"], g["id"]), "note_id": 0,
            "text": g["summary"] or "(Sans titre)", "plain": True,
            "due_at": due_at.astimezone(_tz.utc).isoformat().replace("+00:00", "Z"),
            "due_end_at": due_end.astimezone(_tz.utc).isoformat().replace("+00:00", "Z") if due_end else None,
            "all_day": g["all_day"], "done": False, "color": g["color"], "bucket": bucket,
            "calendar_id": g["calendar_id"], "calendar_summary": g.get("calendar_summary", ""),
            "event_id": g["id"], "start": g["start"],
        })
    return out
