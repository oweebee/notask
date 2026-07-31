"""Libellés (catégories) — façon Keep, affichés dans le menu latéral."""

from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user
from app.models import Label, LabelCreate, LabelOut, LabelUpdate, Note, User
from app.routers.notes import COLORS

router = APIRouter(prefix="/api/labels", tags=["labels"])


def _owned_label(label_id: int, user: User, session: Session) -> Label:
    label = session.get(Label, label_id)
    if label is None or label.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Libellé introuvable")
    return label


def _check_color(color) -> None:
    if color is not None and color not in COLORS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Couleur inconnue : {color}")


@router.get("", response_model=List[LabelOut])
def list_labels(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    # Ordre manuel (glisser-déposer, voir Label.position) d'abord ; les
    # libellés qui partagent encore la même position (jamais réordonnés,
    # ou créés avant cette colonne) retombent sur l'ordre alphabétique —
    # même repli que pour les notes (voir list_notes() dans notes.py).
    return session.exec(
        select(Label).where(Label.user_id == user.id).order_by(Label.position.desc(), Label.name)
    ).all()


@router.post("", response_model=LabelOut, status_code=status.HTTP_201_CREATED)
def create_label(
    payload: LabelCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nom de libellé vide")
    _check_color(payload.color)
    existing = session.exec(
        select(Label).where(Label.user_id == user.id, Label.name == name)
    ).first()
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "Ce libellé existe déjà")

    label = Label(user_id=user.id, name=name, color=payload.color)
    session.add(label)
    session.commit()
    session.refresh(label)
    return label


@router.patch("/{label_id}", response_model=LabelOut)
def update_label(
    label_id: int,
    payload: LabelUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    label = _owned_label(label_id, user, session)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        name = (data["name"] or "").strip()
        if not name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nom de libellé vide")
        dup = session.exec(
            select(Label).where(Label.user_id == user.id, Label.name == name, Label.id != label_id)
        ).first()
        if dup:
            raise HTTPException(status.HTTP_409_CONFLICT, "Ce libellé existe déjà")
        label.name = name
    if "color" in data:
        _check_color(data["color"])
        label.color = data["color"]
    if "position" in data:
        label.position = data["position"]

    session.add(label)
    session.commit()
    session.refresh(label)
    return label


@router.delete("/{label_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_label(
    label_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    label = _owned_label(label_id, user, session)

    # Retirer le libellé des notes qui le portaient, pour ne pas laisser
    # de référence orpheline dans Note.label_ids.
    for note in session.exec(select(Note).where(Note.user_id == user.id)).all():
        if label_id in (note.label_ids or []):
            note.label_ids = [i for i in note.label_ids if i != label_id]
            session.add(note)

    session.delete(label)
    session.commit()
