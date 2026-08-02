"""Connexion Google Calendar par utilisateur (OAuth) + statut.

Flux de connexion (voir google_calendar.py pour le détail des échanges
HTTP avec Google) :

1. Le client navigue (changement de page complet, PAS un fetch) vers
   `/api/google/connect?token=<jwt>`. Un changement de page complet est
   nécessaire car Google doit lui-même rediriger le navigateur en retour —
   impossible de faire ça avec un simple appel fetch(). Le jeton JWT est
   donc passé en paramètre de requête plutôt qu'en en-tête Authorization
   (impossible à poser sur une navigation), mais UNIQUEMENT vers notre
   propre serveur (HTTPS) — jamais vers Google lui-même.
2. connect() vérifie le jeton, crée un état CSRF à usage unique
   (GoogleOAuthState) et redirige vers l'écran de consentement Google avec
   CET état (opaque) comme paramètre `state` — jamais le jeton JWT.
3. Google redirige l'utilisateur vers `/api/google/callback?code=...&state=...`.
   callback() retrouve l'utilisateur via l'état (consommé, à usage unique),
   échange le code contre des jetons, enregistre le compte, puis redirige
   vers l'application.
"""

from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse
from sqlmodel import Session, select

from app import google_calendar as gcal
from app.db import get_session
from app.deps import get_current_admin, get_current_user
from app.models import (
    GoogleAccount,
    GoogleAccountStatus,
    GoogleAdminConfigIn,
    GoogleAdminConfigOut,
    GoogleAppConfig,
    GoogleOAuthState,
    Note,
    NoteItem,
    User,
    utcnow,
)
from app.security import decode_access_token

router = APIRouter(prefix="/api/google", tags=["google"])

# Durée de vie d'un état CSRF de connexion — largement suffisant pour un
# aller-retour vers l'écran de consentement Google, court pour limiter la
# fenêtre d'exploitation si l'URL de callback fuitait quelque part.
STATE_TTL_MINUTES = 10


def _purge_expired_states(session: Session) -> None:
    """Même philosophie que _purge_expired_trash (routers/notes.py) :
    ménage paresseux, fait à la volée plutôt que par une tâche planifiée."""
    cutoff = utcnow() - timedelta(minutes=STATE_TTL_MINUTES)
    expired = session.exec(select(GoogleOAuthState).where(GoogleOAuthState.created_at < cutoff)).all()
    for row in expired:
        session.delete(row)
    if expired:
        session.commit()


def _redirect_uri(request: Request) -> str:
    """Dérivée dynamiquement de la requête plutôt que codée en dur : le
    domaine de déploiement (Coolify/Traefik) n'est pas connu à l'avance.
    Doit être enregistrée telle quelle (schéma+domaine+/api/google/callback)
    comme URI de redirection autorisée dans la console Google Cloud."""
    return str(request.base_url).rstrip("/") + "/api/google/callback"


@router.get("/status", response_model=GoogleAccountStatus)
def status_(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    account = session.exec(select(GoogleAccount).where(GoogleAccount.user_id == user.id)).first()
    if account is None:
        return GoogleAccountStatus(connected=False)
    return GoogleAccountStatus(connected=True, email=account.email, needs_reauth=account.needs_reauth)


@router.get("/connect")
def connect(
    request: Request,
    token: str = Query(...),
    session: Session = Depends(get_session),
):
    if not gcal.is_configured(session):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Intégration Google Calendar non configurée côté serveur (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET manquants)",
        )

    user_id = decode_access_token(token)
    if user_id is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session invalide ou expirée")
    user = session.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session invalide ou expirée")

    _purge_expired_states(session)

    state = gcal.new_state_token()
    session.add(GoogleOAuthState(state=state, user_id=user.id))
    session.commit()

    url = gcal.build_authorize_url(_redirect_uri(request), state, session)
    return RedirectResponse(url, status_code=status.HTTP_302_FOUND)


@router.get("/callback")
def callback(
    request: Request,
    code: Optional[str] = Query(default=None),
    state: Optional[str] = Query(default=None),
    error: Optional[str] = Query(default=None),
    session: Session = Depends(get_session),
):
    _purge_expired_states(session)

    if error or not code or not state:
        return RedirectResponse("/?google=error", status_code=status.HTTP_302_FOUND)

    state_row = session.get(GoogleOAuthState, state)
    if state_row is None:
        # État inconnu ou déjà expiré/purgé — on ne peut pas savoir à quel
        # utilisateur rattacher ce retour, on abandonne proprement.
        return RedirectResponse("/?google=error", status_code=status.HTTP_302_FOUND)
    user_id = state_row.user_id
    session.delete(state_row)  # à usage unique
    session.commit()

    try:
        tokens = gcal.exchange_code(code, _redirect_uri(request), session)
    except Exception:
        return RedirectResponse("/?google=error", status_code=status.HTTP_302_FOUND)

    refresh_token = tokens.get("refresh_token")
    access_token = tokens.get("access_token")
    if not access_token:
        return RedirectResponse("/?google=error", status_code=status.HTTP_302_FOUND)

    email = gcal.fetch_email(access_token)

    account = session.exec(select(GoogleAccount).where(GoogleAccount.user_id == user_id)).first()
    if account is None:
        if not refresh_token:
            # Google ne renvoie pas de refresh_token si l'utilisateur avait
            # déjà autorisé l'appli sans avoir jamais eu prompt=consent — ne
            # devrait pas arriver ici (on force prompt=consent), mais sans
            # refresh_token on ne pourrait pas rafraîchir plus tard : on
            # préfère échouer proprement plutôt que stocker un compte inutilisable.
            return RedirectResponse("/?google=error", status_code=status.HTTP_302_FOUND)
        account = GoogleAccount(user_id=user_id, refresh_token=refresh_token)
    elif refresh_token:
        account.refresh_token = refresh_token

    account.email = email
    account.access_token = access_token
    account.access_token_expires_at = utcnow() + timedelta(seconds=tokens.get("expires_in", 3600))
    account.needs_reauth = False
    account.updated_at = utcnow()
    session.add(account)
    session.commit()

    return RedirectResponse("/?google=connected", status_code=status.HTTP_302_FOUND)


@router.post("/disconnect", status_code=status.HTTP_204_NO_CONTENT)
def disconnect(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    account = session.exec(select(GoogleAccount).where(GoogleAccount.user_id == user.id)).first()
    if account is None:
        return

    if account.refresh_token:
        gcal.revoke(account.refresh_token)

    # On perd la capacité de gérer les événements déjà créés côté Google
    # (plus de jeton) : on vide seulement notre propre référence, sans
    # tenter de les supprimer côté Google — laissés tels quels là-bas.
    notes = session.exec(select(Note).where(Note.user_id == user.id, Note.google_event_id.is_not(None))).all()
    for note in notes:
        note.google_event_id = None
        session.add(note)

    items = session.exec(
        select(NoteItem).join(Note, NoteItem.note_id == Note.id).where(
            Note.user_id == user.id, NoteItem.google_event_id.is_not(None)
        )
    ).all()
    for item in items:
        item.google_event_id = None
        session.add(item)

    session.delete(account)
    session.commit()


# ------------------------- Configuration (admin) -------------------------
# Identifiants OAuth de l'appli (Client ID/Secret Google Cloud) — une seule
# ligne pour toute l'installation (GoogleAppConfig), pas par utilisateur.
# Alternative à GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET en variables
# d'environnement : les deux fonctionnent, la base est prioritaire (voir
# google_calendar._client_config()). Réservé aux administrateurs — ce sont
# des identifiants pour toute l'installation, pas un réglage personnel.

@router.get("/admin-config", response_model=GoogleAdminConfigOut)
def get_admin_config(
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
):
    return GoogleAdminConfigOut(**gcal.config_status(session))


@router.put("/admin-config", status_code=status.HTTP_204_NO_CONTENT)
def set_admin_config(
    payload: GoogleAdminConfigIn,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
):
    row = session.exec(select(GoogleAppConfig)).first()
    if row is None:
        row = GoogleAppConfig()
    row.client_id = payload.client_id.strip()
    # Secret vide => on garde l'existant (cf. commentaire sur
    # GoogleAdminConfigIn) ; s'il n'y en avait pas encore, la config reste
    # incomplète (is_configured()/config_status() l'ignoreront) plutôt que
    # d'échouer bruyamment ici.
    if payload.client_secret and payload.client_secret.strip():
        row.client_secret = payload.client_secret.strip()
    row.updated_at = utcnow()
    session.add(row)
    session.commit()


@router.delete("/admin-config", status_code=status.HTTP_204_NO_CONTENT)
def clear_admin_config(
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
):
    """Revient aux variables d'environnement (si présentes) ou à rien."""
    row = session.exec(select(GoogleAppConfig)).first()
    if row is not None:
        session.delete(row)
        session.commit()


# ---------------------------- Debug temporaire ----------------------------
# Endpoint de diagnostic ponctuel : sync_note()/sync_item() avalent toutes
# leurs exceptions (voir google_calendar.py, en tête de fichier — un souci
# Google ne doit jamais faire échouer la sauvegarde d'une notask), donc
# aucune erreur ne remonte jamais au client ni n'est consultable sans accès
# aux logs serveur. Le temps de diagnostiquer une notask qui reste avec
# google_event_id=null malgré une resauvegarde, cet endpoint (admin
# uniquement) refait le même appel Google en clair, SANS avaler l'erreur,
# pour voir le vrai code HTTP / message renvoyé par Google. À retirer une
# fois le diagnostic terminé — ce n'est pas un endpoint destiné à rester.
@router.post("/debug-sync/{note_id}")
def debug_sync(
    note_id: int,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
):
    note = session.get(Note, note_id)
    if note is None or note.user_id != admin.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND)

    account = gcal._account_for(note.user_id, session)
    if account is None:
        return {"step": "account", "error": "Aucun compte Google lié pour cet utilisateur."}

    info: dict = {
        "note_id": note.id,
        "due_at": note.due_at.isoformat() if note.due_at else None,
        "calendar_title": note.calendar_title,
        "google_event_id": note.google_event_id,
        "account_email": account.email,
        "account_needs_reauth": account.needs_reauth,
        "account_calendar_id": account.calendar_id,
        "has_refresh_token": bool(account.refresh_token),
    }

    import httpx as _httpx

    token = gcal._valid_access_token(account, session)
    info["access_token_obtained"] = bool(token)
    if not token:
        info["step"] = "token"
        info["needs_reauth_after_attempt"] = account.needs_reauth
        return info

    try:
        with _httpx.Client(timeout=gcal.HTTP_TIMEOUT) as client:
            resp = client.post(
                gcal._events_url(account),
                headers={"Authorization": f"Bearer {token}"},
                json=gcal._event_body(note.calendar_title or "(sans titre)", note.due_at, "note", note.id),
            )
        info["step"] = "create_event"
        info["status_code"] = resp.status_code
        info["response_body"] = resp.text[:2000]
    except Exception as exc:
        info["step"] = "create_event"
        info["exception"] = f"{type(exc).__name__}: {exc}"

    return info
