"""Tâches — vue sur les notes datées, sans table dédiée.

Une tâche est soit une note portant une échéance, soit une case à cocher
datée à l'intérieur d'une note. Rien ne se crée ici : toute tâche naît d'une
note. On ne peut que la cocher, la décocher, ou la lire.
"""

from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlmodel import Session, select

from app import google_calendar as gcal
from app.db import get_session
from app.deps import get_current_user
from app.models import Note, NoteItem, TaskDone, TaskOut, User, next_recurrence, utcnow
from app.routers.notes import archiver_si_tout_coche
from app.routers.settings import fuseau_utilisateur

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

BUCKETS = ("late", "today", "imminent", "upcoming", "done")

# Fenêtre des notasks "imminentes" : dues dans ce nombre de jours ou moins,
# sans compter aujourd'hui (qui a déjà son propre regroupement "today").
IMMINENT_WINDOW_DAYS = 7


def _aware(dt: datetime) -> datetime:
    """SQLite renvoie des datetimes sans fuseau : on les considère en UTC."""
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _bucket(due_at: datetime, done: bool, now: datetime, all_day: bool = False,
            due_end_at: Optional[datetime] = None) -> str:
    if done:
        return "done"
    due_at = _aware(due_at)
    # "imminent" : due dans IMMINENT_WINDOW_DAYS jours ou moins, calendaires
    # (pas 168h pile) — une échéance demain matin ou dans 6 jours 23h59 compte
    # pareillement comme "dans les 7 jours". "today" reste prioritaire (testé
    # avant), donc "imminent" ne couvre que demain -> +7 jours.
    limite_imminent = (now + timedelta(days=IMMINENT_WINDOW_DAYS)).date()
    if all_day:
        # due_at/due_end_at valent minuit UTC du jour concerné, par
        # convention (voir NoteBase.all_day) — jamais une heure réelle. Le
        # comparer directement à `now` comme un due_at ordinaire ferait
        # basculer la tâche en retard dès la première seconde du jour même
        # (minuit passé => due_at < now), avant même que la journée n'ait eu
        # lieu. Le retard n'est réel qu'une fois le DERNIER jour de la
        # période totalement écoulé — d'où la borne exclusive fin+1 jour.
        fin = _aware(due_end_at) if due_end_at else due_at
        fin_exclusive = fin + timedelta(days=1)
        if now >= fin_exclusive:
            return "late"
        if now < due_at:
            if due_at.date() <= limite_imminent:
                return "imminent"
            return "upcoming"
        return "today"
    if due_at < now:
        return "late"
    if due_at.date() == now.date():
        return "today"
    if due_at.date() <= limite_imminent:
        return "imminent"
    return "upcoming"


@router.get("", response_model=List[TaskOut])
def list_tasks(
    bucket: Optional[str] = Query(
        default=None, description="late, today, imminent, upcoming ou done ; tout si absent"
    ),
    include_archived: bool = Query(default=False, description="Inclure les notasks archivées"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if bucket is not None and bucket not in BUCKETS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Regroupement inconnu : {bucket}")

    now = utcnow()
    tasks: List[TaskOut] = []

    notes = session.exec(select(Note).where(Note.user_id == user.id)).all()
    by_id = {n.id: n for n in notes}
    # Une note en corbeille n'est plus une tâche, même si elle a une échéance.
    visible = [
        n for n in notes
        if (include_archived or not n.archived) and n.trashed_at is None
    ]

    # 1. Les notes qui portent une échéance
    for n in visible:
        if n.due_at is None:
            continue
        # text = n.title, sans le repli "extrait du contenu si titre vide"
        # d'origine : titre et contenu peuvent être chiffrés de bout en bout
        # côté client (voir app.js), le serveur ne peut plus juger si le
        # titre est "vide" une fois chiffré (une chaîne chiffrée n'est
        # jamais vide même quand le texte en clair l'est), ni découper le
        # contenu chiffré sans casser le déchiffrement. Le repli visuel
        # ("Note sans titre" / extrait du contenu) est donc recalculé côté
        # client, après déchiffrement — voir decorateTaskText() dans app.js.
        tasks.append(TaskOut(
            kind="note",
            id=n.id,
            note_id=n.id,
            note_title=n.title,
            text=n.title,
            due_at=n.due_at,
            due_end_at=n.due_end_at,
            all_day=n.all_day,
            done=n.done,
            color=n.color,
            icon=n.icon,
            recur=n.recur,
            bucket=_bucket(n.due_at, n.done, now, n.all_day, n.due_end_at),
        ))

    # 2. Les lignes à cocher qui portent une échéance
    visible_ids = [n.id for n in visible]
    if visible_ids:
        items = session.exec(
            select(NoteItem).where(
                NoteItem.note_id.in_(visible_ids),
                NoteItem.due_at.is_not(None),
                # Ligne archivée ou jetée seule (voir NoteItem.archived) :
                # elle quitte les tâches sans emporter sa notask parente.
                NoteItem.archived == False,  # noqa: E712 — SQLAlchemy, pas un `is`
                NoteItem.trashed_at.is_(None),
            )
        ).all()
        for it in items:
            parent = by_id[it.note_id]
            tasks.append(TaskOut(
                kind="item",
                id=it.id,
                note_id=parent.id,
                note_title=parent.title,
                text=it.text,
                due_at=it.due_at,
                due_end_at=it.due_end_at,
                all_day=it.all_day,
                done=it.checked,
                color=parent.color,
                icon=parent.icon,
                recur=it.recur,
                bucket=_bucket(it.due_at, it.checked, now, it.all_day, it.due_end_at),
            ))

    if bucket:
        tasks = [t for t in tasks if t.bucket == bucket]

    # Les tâches terminées en dernier, le reste par échéance croissante.
    tasks.sort(key=lambda t: (t.done, _aware(t.due_at)))
    return tasks


@router.patch("/{kind}/{obj_id}", response_model=TaskOut)
def set_done(
    kind: str,
    obj_id: int,
    payload: TaskDone,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Coche ou décoche une tâche, quelle que soit son origine."""
    now = utcnow()

    if kind == "note":
        note = session.get(Note, obj_id)
        if note is None or note.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Tâche introuvable")
        if note.due_at is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cette notask n'a pas d'échéance")

        # Cf. update_note dans routers/notes.py : on reprogramme sur une
        # TRANSITION (décochée -> cochée), pas sur un état.
        etait_done = note.done
        note.done = payload.done
        note.done_at = now if payload.done else None
        note.updated_at = now
        session.add(note)
        session.commit()
        session.refresh(note)
        # Terminer une tâche la retire de l'agenda Google (et la décocher
        # recrée l'événement) — voir should_have_event dans sync_note().
        gcal.sync_note(note, session)

        # Récurrence (voir next_recurrence dans models.py) : UNIQUEMENT au
        # moment où la notask vient d'être cochée terminée — jamais avant.
        # On la décoche aussitôt et on avance son échéance à la semaine/
        # l'année suivante. Un second appel à sync_note() ci-dessus a déjà
        # retiré l'ancien événement Google (should_have_event est devenu
        # False le temps que note.done valait True) ; celui-ci en crée donc
        # un NOUVEAU à la date suivante plutôt que de faire glisser le même.
        if note.done and not etait_done and note.recur and note.due_at is not None:
            nouveau_due, nouveau_fin = next_recurrence(
                note.due_at, note.due_end_at, note.recur,
                fuseau_utilisateur(user.id, session), note.all_day)
            note.done = False
            note.done_at = None
            note.due_at = nouveau_due
            note.due_end_at = nouveau_fin
            note.updated_at = now
            session.add(note)
            session.commit()
            session.refresh(note)
            gcal.sync_note(note, session)

        return TaskOut(
            kind="note", id=note.id, note_id=note.id, note_title=note.title,
            text=note.title, due_at=note.due_at, due_end_at=note.due_end_at, all_day=note.all_day,
            done=note.done, color=note.color, icon=note.icon, recur=note.recur,
            bucket=_bucket(note.due_at, note.done, now, note.all_day, note.due_end_at),
        )

    if kind == "item":
        item = session.get(NoteItem, obj_id)
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Tâche introuvable")
        parent = session.get(Note, item.note_id)
        if parent is None or parent.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Tâche introuvable")
        if item.due_at is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cette ligne n'a pas d'échéance")

        # Cf. la branche "note" ci-dessus : transition, pas état.
        etait_coche = item.checked
        item.checked = payload.done
        session.add(item)
        session.commit()

        # Troisième et dernier chemin par lequel une case peut être cochée :
        # depuis la vue des échéances ou depuis un widget d'écran d'accueil.
        # Même règle qu'ailleurs, appliquée au même endroit — voir
        # archiver_si_tout_coche dans routers/notes.py.
        if archiver_si_tout_coche(parent, session):
            session.commit()

        session.refresh(item)
        gcal.sync_item(item, parent, session)  # cf. sync_note ci-dessus

        # Récurrence — même principe que côté notask ci-dessus, cf.
        # next_recurrence(). Peut faire ressortir la notask parente des
        # archives si archiver_si_tout_coche() venait juste de l'y ranger :
        # cette ligne-ci n'est plus cochée, la liste n'est donc plus "toute
        # cochée" — voir archiver_si_tout_coche pour la réversibilité voulue.
        if item.checked and not etait_coche and item.recur and item.due_at is not None:
            nouveau_due, nouveau_fin = next_recurrence(
                item.due_at, item.due_end_at, item.recur,
                fuseau_utilisateur(user.id, session), item.all_day)
            item.checked = False
            item.due_at = nouveau_due
            item.due_end_at = nouveau_fin
            session.add(item)
            session.commit()
            if archiver_si_tout_coche(parent, session):
                session.commit()
            session.refresh(item)
            gcal.sync_item(item, parent, session)

        return TaskOut(
            kind="item", id=item.id, note_id=parent.id, note_title=parent.title,
            text=item.text, due_at=item.due_at, due_end_at=item.due_end_at, all_day=item.all_day,
            done=item.checked, color=parent.color, icon=parent.icon, recur=item.recur,
            bucket=_bucket(item.due_at, item.checked, now, item.all_day, item.due_end_at),
        )

    raise HTTPException(status.HTTP_400_BAD_REQUEST, "Type de tâche inconnu")
