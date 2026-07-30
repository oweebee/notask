"""Dépendances FastAPI : session base de données et utilisateur courant."""

from typing import Optional

from fastapi import Depends, Header, HTTPException, status
from sqlmodel import Session, select

from app.db import get_session
from app.models import User
from app.security import decode_access_token

CREDENTIALS_ERROR = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Identifiants invalides ou session expirée",
    headers={"WWW-Authenticate": "Bearer"},
)


def get_current_user(
    authorization: Optional[str] = Header(default=None),
    session: Session = Depends(get_session),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise CREDENTIALS_ERROR

    user_id = decode_access_token(authorization.split(" ", 1)[1].strip())
    if user_id is None:
        raise CREDENTIALS_ERROR

    user = session.get(User, user_id)
    if user is None or not user.is_active:
        raise CREDENTIALS_ERROR
    return user


def get_current_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Réservé aux administrateurs")
    return user


def setup_needed(session: Session) -> bool:
    """Vrai tant qu'aucun compte n'existe : l'app reste verrouillée."""
    return session.exec(select(User.id).limit(1)).first() is None
