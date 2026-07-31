"""Gestion des comptes — réservée aux administrateurs."""

from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_admin
from app.models import (
    Label,
    Note,
    NoteAttachment,
    NoteItem,
    User,
    UserCreate,
    UserPublic,
    UserSettings,
    UserUpdate,
)
from app.routers.attachments import ATTACH_DIR
from app.routers.note_versions import delete_all_versions
from app.security import generate_enc_salt, hash_password

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("", response_model=List[UserPublic])
def list_users(
    _: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
):
    return session.exec(select(User).order_by(User.username)).all()


@router.post("", response_model=UserPublic, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    _: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
):
    username = payload.username.strip().lower()
    if session.exec(select(User).where(User.username == username)).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Ce nom d'utilisateur est déjà pris")

    user = User(
        username=username,
        password_hash=hash_password(payload.password),
        is_admin=payload.is_admin,
        must_change_password=True,  # l'utilisateur choisira son propre mot de passe
        enc_salt=generate_enc_salt(),
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


@router.patch("/{user_id}", response_model=UserPublic)
def update_user(
    user_id: int,
    payload: UserUpdate,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Utilisateur introuvable")

    data = payload.model_dump(exclude_unset=True)

    # Garde-fou : ne pas se retirer soi-même les droits ni se désactiver.
    if user.id == admin.id:
        if data.get("is_admin") is False:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Impossible de retirer vos propres droits admin")
        if data.get("is_active") is False:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Impossible de désactiver votre propre compte")

    # Garde-fou : conserver au moins un administrateur actif.
    if data.get("is_admin") is False or data.get("is_active") is False:
        remaining = session.exec(
            select(User).where(User.is_admin == True, User.is_active == True, User.id != user.id)  # noqa: E712
        ).first()
        if remaining is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Il doit rester au moins un administrateur actif")

    if "password" in data and data["password"]:
        user.password_hash = hash_password(data["password"])
        user.must_change_password = True
    if "is_admin" in data:
        user.is_admin = data["is_admin"]
    if "is_active" in data:
        user.is_active = data["is_active"]

    session.add(user)
    session.commit()
    session.refresh(user)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: int,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Utilisateur introuvable")
    if user.id == admin.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Impossible de supprimer votre propre compte")

    # Suppression des données de l'utilisateur (SQLite n'applique pas les cascades par défaut).
    note_ids = session.exec(select(Note.id).where(Note.user_id == user_id)).all()
    for item in session.exec(select(NoteItem).where(NoteItem.note_id.in_(note_ids))).all() if note_ids else []:
        session.delete(item)
    for att in session.exec(select(NoteAttachment).where(NoteAttachment.note_id.in_(note_ids))).all() if note_ids else []:
        path = ATTACH_DIR / att.storage_name
        if path.exists():
            path.unlink()
        session.delete(att)
    for nid in note_ids:
        delete_all_versions(nid, session)
    for note in session.exec(select(Note).where(Note.user_id == user_id)).all():
        session.delete(note)
    for s in session.exec(select(UserSettings).where(UserSettings.user_id == user_id)).all():
        session.delete(s)
    for lbl in session.exec(select(Label).where(Label.user_id == user_id)).all():
        session.delete(lbl)

    session.delete(user)
    session.commit()
