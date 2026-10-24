"""Agendas externes iCal/ICS (voir app/external_calendars.py)."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from app import external_calendars as ext
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
    return [ext.comme_agenda(r) for r in rows]


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
