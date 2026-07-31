"""Historique des versions d'une notask.

Instantané complet (champs + lignes + pièces jointes) pris par le client
juste avant un changement potentiellement destructeur — voir le
commentaire en tête de `NoteVersion` dans app/models.py pour le pourquoi
du déclenchement côté client plutôt qu'automatique à chaque PATCH (le
serveur ne peut pas savoir si un champ chiffré a réellement changé, seul
le client a le texte en clair pour comparer avant/après).

Mêmes conventions que attachments.py : pas de préfixe de routeur, chemins
complets explicites sur chaque route (un préfixe combiné à un chemin vide
`@router.get("")` a un comportement de redirection pas garanti selon les
versions de Starlette — préférer la forme déjà éprouvée ailleurs dans ce
projet plutôt que d'introduire un nouveau motif non testé).
"""

import shutil
import uuid
from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from sqlmodel import Session, select

from app.db import DATA_DIR, get_session
from app.deps import get_current_user
from app.models import (
    Note,
    NoteAttachment,
    NoteItem,
    NoteOut,
    NoteVersion,
    NoteVersionAttachment,
    NoteVersionDetail,
    NoteVersionItem,
    NoteVersionListItem,
    User,
    utcnow,
)
from app.routers.attachments import ATTACH_DIR

router = APIRouter(tags=["note-versions"])

VERSION_ATTACH_DIR = Path(DATA_DIR) / "attachment_versions"
VERSION_ATTACH_DIR.mkdir(parents=True, exist_ok=True)

# "Les 10 dernières versions", demande explicite de l'utilisateur.
MAX_VERSIONS_PER_NOTE = 10


def _owned_note(note_id: int, user: User, session: Session) -> Note:
    note = session.get(Note, note_id)
    if note is None or note.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notask introuvable")
    return note


def _owned_version(note_id: int, version_id: int, user: User, session: Session) -> NoteVersion:
    _owned_note(note_id, user, session)
    version = session.get(NoteVersion, version_id)
    if version is None or version.note_id != note_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Version introuvable")
    return version


def _delete_version_files(version: NoteVersion, session: Session) -> None:
    """Supprime les fichiers de sauvegarde d'un instantané. À appeler avant
    de supprimer la ligne NoteVersion elle-même (le cascade ORM sur les
    lignes NoteVersionAttachment ne touche pas au disque)."""
    for att in session.exec(
        select(NoteVersionAttachment).where(NoteVersionAttachment.version_id == version.id)
    ).all():
        path = VERSION_ATTACH_DIR / att.storage_name
        if path.exists():
            path.unlink()


def delete_all_versions(note_id: int, session: Session) -> None:
    """Nettoyage complet d'une notask supprimée — appelé depuis
    delete_note() (notes.py) et delete_user() (users.py), même logique que
    pour les pièces jointes vivantes (ATTACH_DIR)."""
    for version in session.exec(select(NoteVersion).where(NoteVersion.note_id == note_id)).all():
        _delete_version_files(version, session)
        session.delete(version)


def _prune_versions(note_id: int, session: Session) -> None:
    """Ne garde que les MAX_VERSIONS_PER_NOTE instantanés les plus récents
    pour cette notask, fichiers de sauvegarde compris."""
    versions = session.exec(
        select(NoteVersion)
        .where(NoteVersion.note_id == note_id)
        .order_by(NoteVersion.created_at.desc())
    ).all()
    for old in versions[MAX_VERSIONS_PER_NOTE:]:
        _delete_version_files(old, session)
        session.delete(old)


def _snapshot(note: Note, session: Session) -> NoteVersion:
    """Copie l'état actuel de `note` (champs, lignes, pièces jointes — dont
    les octets, physiquement dupliqués sous VERSION_ATTACH_DIR) dans un
    nouvel instantané, puis applique la limite des 10 derniers."""
    version = NoteVersion(
        note_id=note.id,
        title=note.title,
        description=note.description,
        content=note.content,
        color=note.color,
        is_checklist=note.is_checklist,
        due_at=note.due_at,
        icon=note.icon,
        label_ids=list(note.label_ids or []),
    )
    session.add(version)
    session.flush()  # pour obtenir version.id avant d'ajouter ses enfants

    for item in session.exec(select(NoteItem).where(NoteItem.note_id == note.id)).all():
        session.add(NoteVersionItem(
            version_id=version.id, text=item.text, checked=item.checked, due_at=item.due_at,
        ))

    for att in session.exec(select(NoteAttachment).where(NoteAttachment.note_id == note.id)).all():
        src = ATTACH_DIR / att.storage_name
        if not src.exists():
            continue  # fichier déjà manquant sur disque : rien à copier, on n'invente pas
        backup_name = uuid.uuid4().hex
        shutil.copyfile(src, VERSION_ATTACH_DIR / backup_name)
        session.add(NoteVersionAttachment(
            version_id=version.id,
            original_attachment_id=att.id,
            storage_name=backup_name,
            enc_meta=att.enc_meta,
            size=att.size,
        ))

    session.flush()
    _prune_versions(note.id, session)
    session.commit()
    session.refresh(version)
    return version


@router.post(
    "/api/notes/{note_id}/versions",
    response_model=NoteVersionListItem,
    status_code=status.HTTP_201_CREATED,
)
def create_snapshot(
    note_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    note = _owned_note(note_id, user, session)
    return _snapshot(note, session)


@router.get("/api/notes/{note_id}/versions", response_model=List[NoteVersionListItem])
def list_versions(
    note_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _owned_note(note_id, user, session)
    return session.exec(
        select(NoteVersion)
        .where(NoteVersion.note_id == note_id)
        .order_by(NoteVersion.created_at.desc())
    ).all()


@router.get("/api/notes/{note_id}/versions/{version_id}", response_model=NoteVersionDetail)
def get_version(
    note_id: int,
    version_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return _owned_version(note_id, version_id, user, session)


@router.get("/api/version-attachments/{attachment_id}")
def download_version_attachment(
    attachment_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Octets chiffrés d'une pièce jointe telle que sauvegardée dans un
    instantané — même format brut que /api/attachments/{id}, déchiffrement
    côté client (decryptBinary())."""
    vatt = session.get(NoteVersionAttachment, attachment_id)
    if vatt is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pièce jointe introuvable")
    version = session.get(NoteVersion, vatt.version_id)
    note = session.get(Note, version.note_id) if version else None
    if note is None or note.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pièce jointe introuvable")
    path = VERSION_ATTACH_DIR / vatt.storage_name
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fichier introuvable sur le serveur")
    return Response(content=path.read_bytes(), media_type="application/octet-stream")


@router.post("/api/notes/{note_id}/versions/{version_id}/restore", response_model=NoteOut)
def restore_version(
    note_id: int,
    version_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    note = _owned_note(note_id, user, session)
    version = _owned_version(note_id, version_id, user, session)

    # Restaurer est soi-même une action destructrice pour l'état courant :
    # on la précède d'un instantané, comme n'importe quel autre changement
    # — restaurer une restauration malencontreuse reste ainsi possible.
    _snapshot(note, session)

    note.title = version.title
    note.description = version.description
    note.content = version.content
    note.color = version.color
    note.is_checklist = version.is_checklist
    note.due_at = version.due_at
    note.icon = version.icon
    note.label_ids = list(version.label_ids or [])
    note.updated_at = utcnow()

    # Lignes : remplacées à l'identique par celles de l'instantané (mêmes
    # limites que _replace_items() dans notes.py — de nouvelles lignes,
    # pas de tentative de faire correspondre les anciennes une à une).
    for existing in session.exec(select(NoteItem).where(NoteItem.note_id == note.id)).all():
        session.delete(existing)
    session.flush()
    for it in session.exec(
        select(NoteVersionItem).where(NoteVersionItem.version_id == version.id)
    ).all():
        session.add(NoteItem(note_id=note.id, text=it.text, checked=it.checked, due_at=it.due_at))

    # Pièces jointes : le jeu vivant doit redevenir exactement celui de
    # l'instantané. Si la pièce jointe d'origine existe encore (même id),
    # ses octets sont écrasés sur place (comme le fait l'éditeur d'image) ;
    # sinon une nouvelle est recréée à partir de la sauvegarde. Toute pièce
    # jointe vivante absente de l'instantané est supprimée.
    version_atts = session.exec(
        select(NoteVersionAttachment).where(NoteVersionAttachment.version_id == version.id)
    ).all()
    kept_ids = set()
    for vatt in version_atts:
        backup_path = VERSION_ATTACH_DIR / vatt.storage_name
        if not backup_path.exists():
            continue  # sauvegarde disparue : on ne peut pas la restaurer, on ne bloque pas le reste

        live = None
        if vatt.original_attachment_id is not None:
            candidate = session.get(NoteAttachment, vatt.original_attachment_id)
            if candidate is not None and candidate.note_id == note.id:
                live = candidate

        if live is not None:
            shutil.copyfile(backup_path, ATTACH_DIR / live.storage_name)
            live.enc_meta = vatt.enc_meta
            live.size = vatt.size
            session.add(live)
            kept_ids.add(live.id)
        else:
            new_storage = uuid.uuid4().hex
            shutil.copyfile(backup_path, ATTACH_DIR / new_storage)
            new_att = NoteAttachment(
                note_id=note.id, storage_name=new_storage,
                enc_meta=vatt.enc_meta, size=vatt.size,
            )
            session.add(new_att)
            session.flush()
            kept_ids.add(new_att.id)

    for live in session.exec(select(NoteAttachment).where(NoteAttachment.note_id == note.id)).all():
        if live.id not in kept_ids:
            path = ATTACH_DIR / live.storage_name
            if path.exists():
                path.unlink()
            session.delete(live)

    session.add(note)
    session.commit()
    session.refresh(note)
    return note
