"""Dépôt et relecture des sauvegardes notask sur Google Drive.

Volontairement mince : aucune bibliothèque cliente Google, juste des appels
HTTP à l'API REST via httpx, comme le fait déjà google_calendar.py. Toute la
partie OAuth (autorisation, rafraîchissement, révocation, `needs_reauth`)
est celle du module Calendar et n'est pas redite ici — on lui emprunte
simplement `_valid_access_token`.

CE MODULE NE DÉCHIFFRE RIEN. L'archive de sauvegarde est construite ET
chiffrée par le NAVIGATEUR (voir #export-run dans app.js) ; le serveur ne
fait que transporter des octets opaques jusqu'à Drive et les rapporter. Le
chiffrement de bout en bout de l'application n'est donc pas entamé par
l'ajout de cette destination : Google reçoit exactement ce que
l'utilisateur aurait téléchargé sur son disque.

Scope `drive.file` (voir SCOPES dans google_calendar.py) : l'application ne
voit que les fichiers qu'elle a elle-même créés. D'où le dossier fixe créé
par notask plutôt qu'un dossier choisi dans l'arborescence — et d'où le fait
qu'un fichier déposé À LA MAIN dans ce dossier reste invisible depuis
l'application.
"""

import json
import logging
from typing import Any, Dict, List, Optional

import httpx
from sqlmodel import Session

from app.google_calendar import _valid_access_token
from app.models import GoogleAccount

log = logging.getLogger(__name__)

DRIVE_API = "https://www.googleapis.com/drive/v3"
DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"

MIME_DOSSIER = "application/vnd.google-apps.folder"

# Nom du dossier créé à la racine du Drive. Fixe et non configurable : avec
# `drive.file` l'application ne peut de toute façon pas viser un dossier
# préexistant, un réglage n'aurait donc rien à offrir de plus.
NOM_DOSSIER = "notask — sauvegardes"

# Les archives sont de petits fichiers (quelques centaines de Ko au plus, du
# texte chiffré) : un envoi simple en une requête suffit, pas besoin de l'API
# d'envoi repris (resumable) réservée aux gros transferts.
TIMEOUT = httpx.Timeout(30.0, connect=10.0)


class DriveIndisponible(RuntimeError):
    """Compte non connecté, jeton mort, ou Drive qui refuse.

    Une exception dédiée plutôt qu'un `None` de retour : chaque appelant doit
    choisir entre reconnexion et message d'erreur, et un None se serait
    confondu avec « rien à lister »."""


def _jeton(account: Optional[GoogleAccount], session: Session) -> str:
    if account is None:
        raise DriveIndisponible("Aucun compte Google connecté.")
    jeton = _valid_access_token(account, session)
    if not jeton:
        raise DriveIndisponible(
            "La connexion Google a expiré. Reconnectez le compte depuis Profil."
        )
    return jeton


def _appel(methode: str, url: str, jeton: str, **kwargs: Any) -> httpx.Response:
    """Appel Drive avec traduction des échecs en DriveIndisponible.

    Le message d'erreur de Google est repris tel quel quand il existe : sur un
    scope manquant (compte connecté avant l'ajout de drive.file) il dit
    précisément ce qui manque, ce qu'aucun message écrit ici ne saurait
    deviner."""
    # L'en-tête d'authentification est FUSIONNÉ avec ceux que l'appelant a pu
    # passer (televerser envoie son propre Content-Type multipart), et non
    # posé en argument séparé : deux `headers=` sur client.request() lèvent
    # « got multiple values for keyword argument 'headers' ».
    entetes = {"Authorization": f"Bearer {jeton}"}
    entetes.update(kwargs.pop("headers", {}))
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            resp = client.request(methode, url, headers=entetes, **kwargs)
    except httpx.HTTPError as exc:
        raise DriveIndisponible(f"Google Drive injoignable : {exc}") from exc

    if resp.status_code == 403 and "insufficientPermissions" in resp.text:
        raise DriveIndisponible(
            "Le compte Google a été connecté avant l'ajout de l'accès Drive. "
            "Déconnectez puis reconnectez-le depuis Profil."
        )
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("error", {}).get("message", "")
        except ValueError:
            detail = resp.text[:200]
        raise DriveIndisponible(f"Google Drive a refusé ({resp.status_code}) : {detail}")
    return resp


def dossier_sauvegardes(account: Optional[GoogleAccount], session: Session) -> str:
    """Identifiant du dossier de sauvegardes, créé au premier appel.

    Mémorisé sur le compte (GoogleAccount.drive_folder_id) pour ne pas le
    rechercher à chaque envoi. Si l'utilisateur a supprimé le dossier depuis,
    l'identifiant mémorisé ne répond plus : on en recrée un plutôt que de
    laisser l'utilisateur devant une erreur qu'il ne peut pas résoudre depuis
    l'application."""
    jeton = _jeton(account, session)

    if account.drive_folder_id:
        try:
            resp = _appel(
                "GET",
                f"{DRIVE_API}/files/{account.drive_folder_id}",
                jeton,
                params={"fields": "id,name,trashed"},
            )
            if not resp.json().get("trashed"):
                return account.drive_folder_id
        except DriveIndisponible:
            pass  # disparu ou inaccessible : on repart d'un dossier neuf

    resp = _appel(
        "POST",
        f"{DRIVE_API}/files",
        jeton,
        json={"name": NOM_DOSSIER, "mimeType": MIME_DOSSIER, "parents": ["root"]},
        params={"fields": "id,name"},
    )
    cree = resp.json()
    account.drive_folder_id = cree["id"]
    account.drive_folder_name = cree.get("name", NOM_DOSSIER)
    session.add(account)
    session.commit()
    session.refresh(account)
    return account.drive_folder_id


def televerser(
    account: Optional[GoogleAccount], session: Session, nom: str, donnees: bytes
) -> Dict[str, Any]:
    """Dépose une archive dans le dossier de sauvegardes. Renvoie sa fiche."""
    jeton = _jeton(account, session)
    dossier = dossier_sauvegardes(account, session)

    # Envoi multipart « related » : les métadonnées en JSON puis les octets,
    # dans une seule requête. httpx ne sait pas composer ce type de corps
    # (son `files=` produit du multipart/form-data, que Drive refuse ici),
    # d'où l'assemblage à la main.
    limite = "notask-limite-multipart"
    meta = json.dumps({"name": nom, "parents": [dossier]}).encode()
    corps = (
        f"--{limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".encode()
        + meta
        + f"\r\n--{limite}\r\nContent-Type: application/octet-stream\r\n\r\n".encode()
        + donnees
        + f"\r\n--{limite}--".encode()
    )

    resp = _appel(
        "POST",
        f"{DRIVE_UPLOAD_API}/files",
        jeton,
        params={"uploadType": "multipart", "fields": "id,name,size,createdTime"},
        headers={"Content-Type": f"multipart/related; boundary={limite}"},
        content=corps,
    )
    return resp.json()


def lister(account: Optional[GoogleAccount], session: Session) -> List[Dict[str, Any]]:
    """Sauvegardes présentes dans le dossier, la plus récente en premier."""
    jeton = _jeton(account, session)
    dossier = dossier_sauvegardes(account, session)
    resp = _appel(
        "GET",
        f"{DRIVE_API}/files",
        jeton,
        params={
            "q": f"'{dossier}' in parents and trashed = false",
            "orderBy": "createdTime desc",
            "pageSize": 100,
            "fields": "files(id,name,size,createdTime)",
        },
    )
    return resp.json().get("files", [])


def telecharger(
    account: Optional[GoogleAccount], session: Session, file_id: str
) -> bytes:
    """Rapporte les octets d'une sauvegarde, tels quels (toujours chiffrés si
    l'utilisateur avait posé un mot de passe à l'export)."""
    jeton = _jeton(account, session)
    resp = _appel("GET", f"{DRIVE_API}/files/{file_id}", jeton, params={"alt": "media"})
    return resp.content


def supprimer(account: Optional[GoogleAccount], session: Session, file_id: str) -> None:
    """Met une sauvegarde à la corbeille Drive plutôt que de l'effacer : une
    suppression définitive déclenchée depuis une autre application est
    exactement le genre de geste qu'on regrette."""
    jeton = _jeton(account, session)
    _appel("PATCH", f"{DRIVE_API}/files/{file_id}", jeton, json={"trashed": True})
