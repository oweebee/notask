"""Pièces jointes — fichiers rattachés à une note, chiffrés côté client.

Le serveur ne reçoit jamais que des octets déjà chiffrés (voir
encryptBinary() dans app.js) et un petit champ `meta` chiffré (nom + type
MIME, même format que les autres champs texte). Il stocke le blob sur disque
sous un nom généré (uuid4, sans rapport avec le nom d'origine) et ne peut
jamais savoir ce que contient le fichier.

Pas de préfixe commun sur ce routeur : l'upload est imbriqué sous la note
(`/api/notes/{note_id}/attachments`, pour vérifier la propriété de la note à
la création), mais le téléchargement et la suppression n'ont besoin que de
l'identifiant de la pièce jointe elle-même (`/api/attachments/{id}`).
"""

import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response
from sqlmodel import Session

from app.db import DATA_DIR, get_session
from app.deps import get_current_user
from app.models import AttachmentOut, Note, NoteAttachment, User

router = APIRouter(tags=["attachments"])

ATTACH_DIR = Path(DATA_DIR) / "attachments"
ATTACH_DIR.mkdir(parents=True, exist_ok=True)

# 8 Mo annoncés côté client, plus une marge pour l'overhead d'AES-GCM (IV 12
# octets + tag d'authentification 16 octets) qu'encryptBinary() ajoute avant
# l'envoi : les octets reçus sont donc toujours un peu plus gros que le
# fichier d'origine.
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024 + 1024
MAX_META_CHARS = 2000


def _owned_note(note_id: int, user: User, session: Session) -> Note:
    note = session.get(Note, note_id)
    if note is None or note.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notask introuvable")
    return note


def _owned_attachment(attachment_id: int, user: User, session: Session) -> NoteAttachment:
    """Une pièce jointe n'a pas de user_id propre : la propriété se vérifie
    via la note qui la porte, comme pour les lignes de checklist."""
    att = session.get(NoteAttachment, attachment_id)
    if att is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pièce jointe introuvable")
    note = session.get(Note, att.note_id)
    if note is None or note.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pièce jointe introuvable")
    return att


@router.post(
    "/api/notes/{note_id}/attachments",
    response_model=AttachmentOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_attachment(
    note_id: int,
    file: UploadFile = File(...),
    meta: str = Form(...),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _owned_note(note_id, user, session)

    if len(meta) > MAX_META_CHARS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Métadonnées trop longues")

    content = await file.read()
    if len(content) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Fichier trop volumineux (8 Mo maximum)"
        )

    storage_name = uuid.uuid4().hex
    (ATTACH_DIR / storage_name).write_bytes(content)

    att = NoteAttachment(
        note_id=note_id,
        storage_name=storage_name,
        enc_meta=meta,
        size=len(content),
    )
    session.add(att)
    session.commit()
    session.refresh(att)
    return att


@router.get("/api/attachments/{attachment_id}")
def download_attachment(
    attachment_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Renvoie les octets chiffrés tels quels — déchiffrement côté client
    (voir decryptBinary() dans app.js). Le serveur ne fait que les transporter."""
    att = _owned_attachment(attachment_id, user, session)
    path = ATTACH_DIR / att.storage_name
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fichier introuvable sur le serveur")
    return Response(content=path.read_bytes(), media_type="application/octet-stream")


@router.delete("/api/attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_attachment(
    attachment_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    att = _owned_attachment(attachment_id, user, session)
    path = ATTACH_DIR / att.storage_name
    if path.exists():
        path.unlink()
    session.delete(att)
    session.commit()
