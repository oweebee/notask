"""Réglages par utilisateur — stockage libre.

Le serveur conserve un objet JSON par compte sans en interpréter le contenu.
Ajouter un réglage côté client ne demande donc aucune modification ici.
"""

from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user
from app.models import User, UserSettings, utcnow

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Garde-fou : empêcher qu'un client transforme la table en dépôt de fichiers.
MAX_KEYS = 100
MAX_VALUE_CHARS = 10_000


def _row(user: User, session: Session) -> UserSettings:
    row = session.exec(select(UserSettings).where(UserSettings.user_id == user.id)).first()
    if row is None:
        row = UserSettings(user_id=user.id, data={})
        session.add(row)
        session.commit()
        session.refresh(row)
    return row


def _validate(data: Dict[str, Any]) -> None:
    if not isinstance(data, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Les réglages doivent être un objet JSON")
    if len(data) > MAX_KEYS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Trop de clés (maximum {MAX_KEYS})")
    for key, value in data.items():
        if not isinstance(key, str) or not key:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Les clés doivent être des chaînes non vides")
        if isinstance(value, str) and len(value) > MAX_VALUE_CHARS:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"Valeur trop longue pour « {key} » (maximum {MAX_VALUE_CHARS})"
            )


@router.get("", response_model=Dict[str, Any])
def get_settings(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Renvoie les réglages de l'utilisateur — un objet vide s'il n'en a aucun."""
    return _row(user, session).data


@router.patch("", response_model=Dict[str, Any])
def merge_settings(
    payload: Dict[str, Any] = Body(...),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Fusionne les clés fournies. Une valeur `null` supprime la clé."""
    _validate(payload)
    row = _row(user, session)

    merged = dict(row.data)
    for key, value in payload.items():
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = value
    _validate(merged)

    row.data = merged
    row.updated_at = utcnow()
    session.add(row)
    session.commit()
    session.refresh(row)
    return row.data


@router.put("", response_model=Dict[str, Any])
def replace_settings(
    payload: Dict[str, Any] = Body(...),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Remplace intégralement les réglages."""
    _validate(payload)
    row = _row(user, session)
    row.data = payload
    row.updated_at = utcnow()
    session.add(row)
    session.commit()
    session.refresh(row)
    return row.data
