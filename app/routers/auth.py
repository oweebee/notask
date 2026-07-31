from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user, setup_needed
from app.models import (
    EncKeyIn,
    LoginRequest,
    PasswordChange,
    Token,
    User,
    UserCreate,
    UserPublic,
)
from app.security import create_access_token, generate_enc_salt, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/status")
def status_(session: Session = Depends(get_session)):
    """Indique si l'application attend encore sa configuration initiale."""
    return {"needs_setup": setup_needed(session)}


@router.post("/setup", response_model=Token, status_code=status.HTTP_201_CREATED)
def initial_setup(payload: UserCreate, session: Session = Depends(get_session)):
    """Crée le compte administrateur. Possible uniquement tant qu'aucun compte n'existe."""
    if not setup_needed(session):
        raise HTTPException(status.HTTP_409_CONFLICT, "L'application est déjà configurée")

    admin = User(
        username=payload.username.strip().lower(),
        password_hash=hash_password(payload.password),
        is_admin=True,
        enc_salt=generate_enc_salt(),
    )
    session.add(admin)
    session.commit()
    session.refresh(admin)

    return Token(
        access_token=create_access_token(admin.id),
        user=UserPublic.model_validate(admin, from_attributes=True),
    )


@router.post("/login", response_model=Token)
def login(payload: LoginRequest, session: Session = Depends(get_session)):
    if setup_needed(session):
        raise HTTPException(status.HTTP_409_CONFLICT, "Application non configurée")

    user = session.exec(
        select(User).where(User.username == payload.username.strip().lower())
    ).first()

    # Message identique dans tous les cas : ne pas révéler l'existence d'un compte.
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Nom d'utilisateur ou mot de passe incorrect")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Ce compte est désactivé")

    # Comptes créés avant le chiffrement de bout en bout : pas encore de sel.
    # Généré et conservé à la première connexion suivant la mise à jour,
    # plutôt que par une migration à part.
    if not user.enc_salt:
        user.enc_salt = generate_enc_salt()
        session.add(user)
        session.commit()
        session.refresh(user)

    return Token(
        access_token=create_access_token(user.id),
        user=UserPublic.model_validate(user, from_attributes=True),
    )


@router.get("/me", response_model=UserPublic)
def me(user: User = Depends(get_current_user)):
    return user


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: PasswordChange,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mot de passe actuel incorrect")

    user.password_hash = hash_password(payload.new_password)
    user.must_change_password = False
    session.add(user)
    session.commit()


@router.put("/enc-key", status_code=status.HTTP_204_NO_CONTENT)
def set_enc_key(
    payload: EncKeyIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Enregistre la clé de chiffrement des notes (DEK), déjà enveloppée
    côté client. Appelé après chaque connexion sans DEK existante (première
    connexion, ou après une réinitialisation de mot de passe par un admin),
    et après tout changement de mot de passe volontaire (réenveloppement,
    voir PasswordChange / rewrapDekForNewPassword() dans app.js). Le serveur
    ne fait que stocker cette chaîne opaque, sans jamais pouvoir la lire."""
    user.wrapped_dek = payload.wrapped_dek
    session.add(user)
    session.commit()
