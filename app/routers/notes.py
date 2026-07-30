"""Notes — l'unique objet créable.

Une échéance posée sur une note, ou sur l'une de ses cases à cocher, en fait
une tâche visible dans la vue Tâches. Voir app/routers/tasks.py.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user
from app.models import (
    Note,
    NoteCreate,
    NoteItem,
    NoteItemIn,
    NoteItemOut,
    NoteItemUpdate,
    NoteOut,
    NoteUpdate,
    User,
    utcnow,
)

router = APIRouter(prefix="/api/notes", tags=["notes"])

COLORS = {
    "default", "red", "coral", "orange", "amber", "yellow", "lime",
    "green", "emerald", "teal", "cyan", "blue", "indigo", "violet",
    "purple", "magenta", "pink", "rose", "brown", "slate", "grey",
}


def _owned_note(note_id: int, user: User, session: Session) -> Note:
    note = session.get(Note, note_id)
    if note is None or note.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Note introuvable")
    return note


def _check_color(color: Optional[str]) -> None:
    if color is not None and color not in COLORS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Couleur inconnue : {color}")


def _replace_items(note: Note, items: List[NoteItemIn], session: Session) -> None:
    """Remplace les lignes en conservant les échéances des lignes réutilisées."""
    for existing in session.exec(select(NoteItem).where(NoteItem.note_id == note.id)).all():
        session.delete(existing)
    session.flush()
    for position, item in enumerate(items):
        session.add(NoteItem(
            note_id=note.id,
            text=item.text,
            checked=item.checked,
            due_at=item.due_at,
            position=position,
        ))


@router.get("", response_model=List[NoteOut])
def list_notes(
    archived: bool = Query(default=False, description="Afficher les notes archivées"),
    q: Optional[str] = Query(default=None, description="Recherche titre et contenu"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    stmt = select(Note).where(Note.user_id == user.id, Note.archived == archived)
    if q:
        stmt = stmt.where(Note.title.contains(q) | Note.content.contains(q))
    # Épinglées d'abord, puis les plus récemment modifiées.
    return session.exec(stmt.order_by(Note.pinned.desc(), Note.updated_at.desc())).all()


@router.post("", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
def create_note(
    payload: NoteCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _check_color(payload.color)
    note = Note(**payload.model_dump(exclude={"items"}), user_id=user.id)
    session.add(note)
    session.flush()
    _replace_items(note, payload.items, session)
    session.commit()
    session.refresh(note)
    return note


@router.get("/{note_id}", response_model=NoteOut)
def get_note(
    note_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return _owned_note(note_id, user, session)


@router.patch("/{note_id}", response_model=NoteOut)
def update_note(
    note_id: int,
    payload: NoteUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    note = _owned_note(note_id, user, session)
    data = payload.model_dump(exclude_unset=True)
    _check_color(data.get("color"))

    # Sans échéance, une note n'est pas une tâche : rien à terminer.
    if data.get("done") and (data.get("due_at", note.due_at) is None):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Une note sans échéance ne peut pas être marquée terminée",
        )

    if "done" in data and data["done"] != note.done:
        note.done_at = utcnow() if data["done"] else None

    # Retirer l'échéance annule aussi l'état terminé.
    if "due_at" in data and data["due_at"] is None:
        note.done = False
        note.done_at = None
        data.pop("done", None)

    items = data.pop("items", None)
    for key, value in data.items():
        setattr(note, key, value)
    if items is not None:
        _replace_items(note, [NoteItemIn(**i) for i in items], session)

    note.updated_at = utcnow()
    session.add(note)
    session.commit()
    session.refresh(note)
    return note


@router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_note(
    note_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    note = _owned_note(note_id, user, session)
    for item in session.exec(select(NoteItem).where(NoteItem.note_id == note.id)).all():
        session.delete(item)
    session.delete(note)
    session.commit()


# -------------------- Lignes à cocher, une par une --------------------
# Utile pour dater une ligne ou la cocher sans réécrire toute la note.

@router.patch("/{note_id}/items/{item_id}", response_model=NoteItemOut)
def update_item(
    note_id: int,
    item_id: int,
    payload: NoteItemUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _owned_note(note_id, user, session)
    item = session.get(NoteItem, item_id)
    if item is None or item.note_id != note_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ligne introuvable")

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(item, key, value)

    session.add(item)
    session.commit()
    session.refresh(item)
    return item
