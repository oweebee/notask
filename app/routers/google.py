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

import json
import logging
from datetime import datetime, timedelta
from typing import Optional

from fastapi import (
    APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status,
)
from fastapi.responses import RedirectResponse, Response
from sqlmodel import Session, select

from app import google_calendar as gcal
from app import google_drive as gdrive
from app import google_overlay as gov
from app import external_calendars as extcal
from app.routers.settings import fuseau_utilisateur
from app.db import get_session
from app.deps import get_current_user
from app.models import (
    CalendarEventDone,
    ExternalCalendar,
    GoogleAccount,
    GoogleAccountStatus,
    GoogleAppConfig,
    GoogleCalendarIn,
    GoogleFeaturesIn,
    GoogleOverlayEventIn,
    GoogleOverlaySeriesIn,
    GoogleOverlayVisibleIn,
    GoogleOAuthState,
    GoogleUserAppConfig,
    GoogleUserConfigIn,
    GoogleUserConfigOut,
    Note,
    NoteItem,
    User,
    utcnow,
)
from app.security import decode_access_token

router = APIRouter(prefix="/api/google", tags=["google"])
log = logging.getLogger("notask.google")

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
    return GoogleAccountStatus(
        connected=True,
        email=account.email,
        needs_reauth=account.needs_reauth,
        calendar_enabled=account.calendar_enabled,
        drive_enabled=account.drive_enabled,
        calendars_view_enabled=account.calendars_view_enabled,
    )


@router.get("/connect")
def connect(
    request: Request,
    token: str = Query(...),
    session: Session = Depends(get_session),
):
    user_id = decode_access_token(token)
    if user_id is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session invalide ou expirée")
    user = session.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session invalide ou expirée")

    # is_configured() dépend maintenant de CET utilisateur (GoogleUserAppConfig,
    # bascule franche, plus de réglage global) : il faut donc le résoudre
    # avant de pouvoir vérifier la config, contrairement à avant.
    if not gcal.is_configured(session, user.id):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Identifiants Google (Client ID/Secret) non configurés pour ce compte — voir Profil.",
        )

    _purge_expired_states(session)

    state = gcal.new_state_token()
    session.add(GoogleOAuthState(state=state, user_id=user.id))
    session.commit()

    url = gcal.build_authorize_url(_redirect_uri(request), state, session, user.id)
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
        tokens = gcal.exchange_code(code, _redirect_uri(request), session, user_id)
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

    # Adresse publique de l'installation, relevée ici parce que c'est le seul
    # endroit où le serveur la connaît à coup sûr telle que le navigateur la
    # voit : la synchro (sync_note/sync_item) tourne sans aucun contexte de
    # requête et ne pourrait pas la deviner. Sert au lien « Ouvrir dans
    # notask » ajouté à la description des événements.
    config = session.exec(select(GoogleAppConfig)).first()
    if config is None:
        config = GoogleAppConfig()
    config.base_url = str(request.base_url).rstrip("/")
    session.add(config)

    account.email = email
    account.access_token = access_token
    account.access_token_expires_at = utcnow() + timedelta(seconds=tokens.get("expires_in", 3600))
    account.needs_reauth = False
    account.updated_at = utcnow()
    session.add(account)
    session.commit()

    return RedirectResponse("/?google=connected", status_code=status.HTTP_302_FOUND)


@router.get("/calendars")
def list_calendars(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Agendas disponibles + celui actuellement sélectionné, pour le choix
    de destination dans Profil. `error` non nul = liste indisponible (le
    client bascule alors sur une saisie manuelle de l'identifiant, voir
    chargerAgendasGoogle() dans app.js)."""
    account = session.exec(select(GoogleAccount).where(GoogleAccount.user_id == user.id)).first()
    if account is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Aucun compte Google connecté")
    data = gcal.list_calendars(account, session)
    data["current"] = account.calendar_id
    return data


@router.put("/calendar")
def set_calendar(
    payload: GoogleCalendarIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Change l'agenda de destination. Les événements déjà créés sont
    déplacés (supprimés de l'ancien agenda puis recréés dans le nouveau,
    voir gcal.change_calendar) — sans quoi ils resteraient orphelins."""
    account = session.exec(select(GoogleAccount).where(GoogleAccount.user_id == user.id)).first()
    if account is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Aucun compte Google connecté")

    nouveau = payload.calendar_id.strip()
    if not nouveau:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Identifiant d'agenda vide")

    resultat = gcal.change_calendar(account, nouveau, session)
    return {"calendar_id": account.calendar_id, **resultat}


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


# --------------------------- Configuration (perso) ---------------------------
# Identifiants OAuth Google (Client ID/Secret Google Cloud) PAR UTILISATEUR
# (GoogleUserAppConfig) — bascule franche : il n'y a plus de réglage
# partagé pour toute l'installation (voir models.py, ancien GoogleAppConfig.
# client_id/client_secret, retirés) ni de repli sur variables
# d'environnement. Ouvert à tout utilisateur connecté (get_current_user,
# pas get_current_admin) : chacun ne lit/modifie que SA PROPRE ligne.

@router.get("/my-config", response_model=GoogleUserConfigOut)
def get_my_config(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return GoogleUserConfigOut(**gcal.config_status(session, user.id))


@router.put("/my-config", status_code=status.HTTP_204_NO_CONTENT)
def set_my_config(
    payload: GoogleUserConfigIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    row = session.exec(
        select(GoogleUserAppConfig).where(GoogleUserAppConfig.user_id == user.id)
    ).first()
    if row is None:
        row = GoogleUserAppConfig(user_id=user.id)
    row.client_id = payload.client_id.strip()
    # Secret vide => on garde l'existant (cf. commentaire sur
    # GoogleUserConfigIn) ; s'il n'y en avait pas encore, la config reste
    # incomplète (is_configured()/config_status() l'ignoreront) plutôt que
    # d'échouer bruyamment ici.
    if payload.client_secret and payload.client_secret.strip():
        row.client_secret = payload.client_secret.strip()
    row.updated_at = utcnow()
    session.add(row)
    session.commit()


@router.delete("/my-config", status_code=status.HTTP_204_NO_CONTENT)
def clear_my_config(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Efface les identifiants perso de cet utilisateur. Plus de repli
    (ni variables d'environnement, ni réglage global) : ses connexions
    Google existantes resteront visibles mais ne pourront plus se
    rafraîchir tant qu'il n'aura pas reconfiguré puis reconnecté son
    compte (voir needs_reauth dans _valid_access_token)."""
    row = session.exec(
        select(GoogleUserAppConfig).where(GoogleUserAppConfig.user_id == user.id)
    ).first()
    if row is not None:
        session.delete(row)
        session.commit()


# ----------------------- Sauvegardes sur Google Drive -----------------------
# Le serveur n'est qu'un RELAIS : l'archive est construite et chiffrée par le
# navigateur (voir #export-run dans app.js), elle traverse ici sous forme
# d'octets opaques. Ce détour par le serveur est nécessaire parce que le
# refresh_token Google ne quitte jamais la base — le navigateur n'a aucun
# moyen d'appeler Drive directement, et lui confier ce jeton reviendrait à
# l'exposer à toute extension installée chez l'utilisateur.


def _compte_google(user: User, session: Session) -> GoogleAccount:
    """Compte utilisable POUR DRIVE. Pendant de _account_for() côté agenda :
    l'interrupteur `drive_enabled` est vérifié ici, seul passage des quatre
    routes Drive, plutôt que répété dans chacune."""
    compte = session.exec(
        select(GoogleAccount).where(GoogleAccount.user_id == user.id)
    ).first()
    if compte is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Aucun compte Google connecté. Connectez-le depuis Profil.",
        )
    if not compte.drive_enabled:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Les sauvegardes Google Drive sont désactivées. Activez-les depuis Profil.",
        )
    return compte


@router.put("/features", status_code=status.HTTP_204_NO_CONTENT)
def maj_fonctions(
    payload: GoogleFeaturesIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Active ou désactive l'agenda et les sauvegardes Drive, séparément.

    Ne touche NI au jeton NI au compte lui-même : désactiver les deux
    fonctions laisse le compte relié, prêt à resservir. Pour couper l'accès
    pour de bon, c'est « Déconnecter » qui révoque le jeton côté Google."""
    compte = session.exec(
        select(GoogleAccount).where(GoogleAccount.user_id == user.id)
    ).first()
    if compte is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Aucun compte Google connecté.")
    compte.calendar_enabled = payload.calendar_enabled
    compte.drive_enabled = payload.drive_enabled
    if payload.calendars_view_enabled is not None:
        compte.calendars_view_enabled = payload.calendars_view_enabled
    session.add(compte)
    session.commit()


@router.get("/drive/backups")
def drive_lister(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Sauvegardes déjà déposées, la plus récente en premier."""
    try:
        return gdrive.lister(_compte_google(user, session), session)
    except gdrive.DriveIndisponible as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))


@router.post("/drive/backups", status_code=status.HTTP_201_CREATED)
async def drive_deposer(
    fichier: UploadFile = File(...),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Dépose une archive produite par le navigateur."""
    donnees = await fichier.read()
    if not donnees:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Archive vide.")
    nom = fichier.filename or "notask.notask"
    try:
        return gdrive.televerser(_compte_google(user, session), session, nom, donnees)
    except gdrive.DriveIndisponible as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))


@router.get("/drive/backups/{file_id}")
def drive_recuperer(
    file_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Rapporte une archive telle quelle, au navigateur qui la déchiffrera."""
    try:
        donnees = gdrive.telecharger(_compte_google(user, session), session, file_id)
    except gdrive.DriveIndisponible as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))
    return Response(content=donnees, media_type="application/octet-stream")


@router.delete("/drive/backups/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def drive_supprimer(
    file_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Met l'archive à la corbeille Drive (jamais de suppression définitive)."""
    try:
        gdrive.supprimer(_compte_google(user, session), session, file_id)
    except gdrive.DriveIndisponible as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))


# ================= Agendas Google dans Calendritasks =================
# Voir app/google_overlay.py : lecture des agendas choisis et gestion de
# leurs RDV. Rien n'est stocké hormis la liste des agendas affichés.

def _compte_overlay(user: User, session: Session) -> GoogleAccount:
    compte = session.exec(
        select(GoogleAccount).where(GoogleAccount.user_id == user.id)
    ).first()
    if compte is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Aucun compte Google connecté.")
    if not compte.calendars_view_enabled:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Affichage des agendas Google désactivé. Activez-le dans Options.",
        )
    return compte


def _http(err: "gov.OverlayError") -> HTTPException:
    return HTTPException(err.status_code, str(err))


@router.get("/overlay/calendars")
def overlay_agendas(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    compte = session.exec(select(GoogleAccount).where(GoogleAccount.user_id == user.id)).first()
    if compte is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Aucun compte Google connecté.")
    try:
        cals = gov.lister_agendas(compte, session)
    except gov.OverlayError as err:
        raise _http(err)
    return {"calendars": cals}


@router.put("/overlay/visible", status_code=status.HTTP_204_NO_CONTENT)
def overlay_visibles(
    payload: GoogleOverlayVisibleIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    compte = session.exec(select(GoogleAccount).where(GoogleAccount.user_id == user.id)).first()
    if compte is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Aucun compte Google connecté.")
    ids = [i for i in dict.fromkeys(payload.visible) if isinstance(i, str) and 0 < len(i) <= 300][:gov.MAX_CALENDRIERS]
    compte.visible_calendars = json.dumps(ids)
    session.add(compte)
    session.commit()


def _parse_borne(val: str, nom: str) -> datetime:
    try:
        dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{nom} invalide")
    if dt.tzinfo is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{nom} sans fuseau")
    return dt


def _maj_liste(user: User, session: Session, ids_bruts, champ: str) -> None:
    compte = session.exec(select(GoogleAccount).where(GoogleAccount.user_id == user.id)).first()
    if compte is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Aucun compte Google connecté.")
    ids = [i for i in dict.fromkeys(ids_bruts) if isinstance(i, str) and 0 < len(i) <= 300][:gov.MAX_CALENDRIERS]
    setattr(compte, champ, json.dumps(ids))
    session.add(compte)
    session.commit()


@router.put("/overlay/agenda", status_code=status.HTTP_204_NO_CONTENT)
def overlay_echeances(
    payload: GoogleOverlayVisibleIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Agendas dont les RDV rejoignent la colonne d'échéances. Date de
    première activation mémorisée par agenda (voir agenda_depuis)."""
    _maj_liste(user, session, payload.visible, "agenda_calendars")
    compte = session.exec(select(GoogleAccount).where(GoogleAccount.user_id == user.id)).first()
    anciens = gov.depuis(compte)
    maintenant = utcnow().isoformat()
    compte.agenda_depuis = json.dumps({i: anciens.get(i, maintenant) for i in (gov.pour_echeances(compte) or [])})
    session.add(compte)
    session.commit()


@router.get("/overlay/series")
def overlay_series(
    calendar_id: str = Query(..., min_length=1, max_length=300),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Séries récurrentes d'UN agenda (Google, virtuel ou « ics:<id> »),
    vues sur 30 j passés → 70 j à venir, avec leur inclusion en échéances.
    Une série annuelle (anniversaire) hors de cette fenêtre n'apparaît pas."""
    maintenant = utcnow()
    debut, fin = maintenant - timedelta(days=30), maintenant + timedelta(days=70)
    compte = session.exec(select(GoogleAccount).where(GoogleAccount.user_id == user.id)).first()
    if calendar_id.startswith("ics:"):
        try:
            row = session.get(ExternalCalendar, int(calendar_id[4:]))
        except ValueError:
            row = None
        if row is None or row.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Agenda introuvable")
        try:
            evs = extcal.evenements(row, debut, fin, fuseau_utilisateur(user.id, session))
        except extcal.ExterneErreur as err:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(err))
    else:
        if compte is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Aucun compte Google connecté.")
        try:
            evs = gov.evenements_d_un_agenda(compte, session, calendar_id, debut, fin)
        except gov.OverlayError as err:
            raise _http(err)
    exclues = gov.series_exclues(compte)
    series = {}
    for ev in evs:
        sid = ev.get("recurring_event_id")
        if not sid:
            continue
        s = series.setdefault(sid, {"id": sid, "summary": ev["summary"] or "(Sans titre)", "count": 0,
                                    "next": None, "included": (calendar_id, sid) not in exclues})
        s["count"] += 1
        if ev.get("rrule"):
            s["rrule"] = ev["rrule"]
        fin_ev = ev["end"]
        if s["next"] is None and fin_ev >= maintenant.date().isoformat()[:10]:
            s["next"] = ev["start"]
    # Règle de répétition (« chaque année, sans fin »…) : maître Google lu à
    # part (les instances ne la portent pas) ; ICS : déjà dans la source.
    if not calendar_id.startswith("ics:") and series:
        try:
            regles = gov.regles_series(compte, session, calendar_id, list(series))
        except gov.OverlayError:
            regles = {}
        for sid, regle in regles.items():
            series[sid]["rrule"] = regle
    for s in series.values():
        s["recurrence"] = gov.decrire_rrule(s.pop("rrule", None)) or "récurrent"
    return {"series": sorted(series.values(), key=lambda s: s["summary"].lower())}


@router.put("/overlay/series", status_code=status.HTTP_204_NO_CONTENT)
def overlay_series_maj(
    payload: GoogleOverlaySeriesIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    compte = session.exec(select(GoogleAccount).where(GoogleAccount.user_id == user.id)).first()
    if compte is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Aucun compte Google connecté.")
    exclues = gov.series_exclues(compte)
    cle = (payload.calendar_id, payload.series_id)
    if payload.included:
        exclues.discard(cle)
    else:
        exclues.add(cle)
    compte.series_exclues = json.dumps(sorted([list(c) for c in exclues]))
    session.add(compte)
    session.commit()


@router.put("/overlay/recurrents", status_code=status.HTTP_204_NO_CONTENT)
def overlay_recurrents(
    payload: GoogleOverlayVisibleIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Agendas dont les RDV RÉCURRENTS ne comptent pas en échéances
    (`visible` = liste des agendas EXCLUS, y compris « ics:<id> »)."""
    _maj_liste(user, session, payload.visible, "recurrents_exclus")


@router.put("/overlay/available", status_code=status.HTTP_204_NO_CONTENT)
def overlay_disponibles(
    payload: GoogleOverlayVisibleIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Agendas proposés dans Calendritasks (barre d'agendas)."""
    _maj_liste(user, session, payload.visible, "available_calendars")


@router.get("/overlay/events")
def overlay_evenements(
    start: str = Query(..., max_length=40),
    end: str = Query(..., max_length=40),
    pour: str = Query("calendar", pattern="^(calendar|agenda)$"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """RDV Google (si l'affichage est activé) + agendas externes iCal.
    Toujours 200 quand rien n'est actif ({"enabled": false}) : Calendritasks
    interroge à chaque période affichée, ce n'est pas une erreur. Un agenda
    en échec est signalé dans `errors` sans faire échouer les autres."""
    debut, fin = _parse_borne(start, "start"), _parse_borne(end, "end")
    if fin <= debut or fin - debut > timedelta(days=100):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Période invalide (100 jours max)")
    resultat = {"enabled": False, "calendars": [], "events": [], "errors": []}
    compte = session.exec(select(GoogleAccount).where(GoogleAccount.user_id == user.id)).first()
    if compte is not None and compte.calendars_view_enabled:
        try:
            resultat = gov.lister_evenements(compte, session, debut, fin, pour_agenda=pour == "agenda")
        except gov.OverlayError as err:
            resultat = {"enabled": True, "calendars": [], "events": [], "errors": [f"Google : {err}"]}
    # Agendas « Échéances » sans date d'activation (réglage antérieur) : datés
    # de maintenant, une fois — aucun retard rétroactif.
    if pour == "agenda":
        if compte is not None and compte.calendars_view_enabled:
            dates = gov.depuis(compte)
            manquants = [c["id"] for c in resultat["calendars"] if c.get("in_agenda") and not dates.get(c["id"])]
            if manquants:
                maintenant = utcnow().isoformat()
                for cid in manquants:
                    dates[cid] = maintenant
                for c in resultat["calendars"]:
                    if c["id"] in manquants:
                        c["agenda_since"] = maintenant
                compte.agenda_depuis = json.dumps(dates)
                session.add(compte)
                session.commit()
    externes = session.exec(select(ExternalCalendar).where(ExternalCalendar.user_id == user.id)).all()
    for e in externes:
        if e.in_agenda and e.in_agenda_since is None:
            e.in_agenda_since = utcnow()
            session.add(e)
            session.commit()
            session.refresh(e)
    if externes:
        resultat["enabled"] = True
        fuseau = fuseau_utilisateur(user.id, session)
        for e in externes:
            resultat["calendars"].append(extcal.comme_agenda(e))
            if not (e.in_agenda if pour == "agenda" else (e.available and e.visible)):
                continue
            try:
                resultat["events"].extend(extcal.evenements(e, debut, fin, fuseau))
            except extcal.ExterneErreur as err:
                resultat["errors"].append(f"{e.name} : {err}")
            except Exception:
                log.exception("Agenda externe %s illisible", e.id)
                resultat["errors"].append(f"{e.name} : illisible")
    # Séries récurrentes exclues des échéances, une par une (bouton
    # « Séries » du panneau Options, voir /overlay/series).
    exclues = gov.series_exclues(compte)
    if pour == "agenda" and exclues:
        resultat["events"] = [ev for ev in resultat["events"]
                              if not (ev.get("recurring_event_id")
                                      and (ev["calendar_id"], ev["recurring_event_id"]) in exclues)]
    # RDV validés depuis notask (case cochée) : marqués, pas retirés — la
    # vue calendrier les montre barrés, la colonne d'échéances les écarte.
    valides = {(v.calendar_id, v.event_id): v.id for v in session.exec(
        select(CalendarEventDone).where(CalendarEventDone.user_id == user.id)).all()}
    for ev in resultat["events"]:
        vid = valides.get((ev["calendar_id"], ev["id"]))
        ev["done"] = vid is not None
        ev["done_id"] = vid
    return resultat


@router.post("/overlay/events", status_code=status.HTTP_204_NO_CONTENT)
def overlay_creer(
    payload: GoogleOverlayEventIn,
    calendar_id: str = Query(..., min_length=1, max_length=300),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    compte = _compte_overlay(user, session)
    try:
        gov.creer(compte, session, calendar_id, payload.model_dump(exclude_unset=True))
    except gov.OverlayError as err:
        raise _http(err)


@router.patch("/overlay/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def overlay_modifier(
    event_id: str,
    payload: GoogleOverlayEventIn,
    calendar_id: str = Query(..., min_length=1, max_length=300),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    compte = _compte_overlay(user, session)
    try:
        gov.modifier(compte, session, calendar_id, event_id, payload.model_dump(exclude_unset=True))
    except gov.OverlayError as err:
        raise _http(err)


@router.delete("/overlay/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def overlay_supprimer(
    event_id: str,
    calendar_id: str = Query(..., min_length=1, max_length=300),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    compte = _compte_overlay(user, session)
    try:
        gov.supprimer(compte, session, calendar_id, event_id)
    except gov.OverlayError as err:
        raise _http(err)
