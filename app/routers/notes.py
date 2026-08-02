"""Notes — l'unique objet créable.

Une échéance posée sur une note, ou sur l'une de ses cases à cocher, en fait
une tâche visible dans la vue Tâches. Voir app/routers/tasks.py.
"""

from datetime import timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlmodel import Session, select

from app import google_calendar as gcal
from app.db import get_session
from app.deps import get_current_user
from app.models import (
    Label,
    Note,
    NoteAttachment,
    NoteCreate,
    NoteItem,
    NoteItemIn,
    NoteItemOut,
    NoteItemUpdate,
    NoteOut,
    NoteUpdate,
    User,
    utcnow,
)
from app.routers.attachments import ATTACH_DIR
from app.routers.note_versions import delete_all_versions

router = APIRouter(prefix="/api/notes", tags=["notes"])

# Une note en corbeille est purgée définitivement au bout de ce délai — voir
# _purge_expired_trash(), appelée à chaque list_notes().
TRASH_RETENTION_DAYS = 30

# 24 teintes : deux rangées pleines de 12 dans le sélecteur (voir COLORS
# dans app.js et les classes .c-* dans style.css — les trois listes doivent
# rester synchronisées, sinon le serveur refuse une couleur pourtant
# proposée à l'écran).
COLORS = {
    "default", "red", "coral", "orange", "amber", "yellow", "lime",
    "green", "emerald", "teal", "cyan", "blue", "indigo", "violet",
    "purple", "magenta", "pink", "rose", "brown", "slate", "grey",
    "navy", "olive", "white",
}

# Jeu fixe d'icônes proposées à gauche du titre, à la création comme à
# l'édition. Doit rester synchronisé avec l'objet ICON_CHOICES d'app.js.
ICON_KEYS = {
    "star", "home", "work", "shopping", "heart", "flag", "book",
    "idea", "travel", "gift", "money", "music",
    "spoonyellow", "spoonblue", "spoons",
    # Lot ajouté pour étoffer le choix — synchronisé avec ICON_CHOICES
    # côté client (app.js).
    "health", "sport", "car", "laptop", "school", "plant", "camera",
    "game", "tool", "warning", "lock", "globe", "phone", "mail",
    "coffee", "sun", "moon", "paw", "food", "document",
    # Encore un lot (35 -> 55) — synchronisé avec ICON_CHOICES côté client.
    "fish", "bird", "tree", "flower", "pizza", "cake", "bike", "plane",
    "train", "paintbrush", "football", "bed", "key", "umbrella", "alarm",
    "target", "cloud", "scissors", "magnifier", "gem",
}


def _owned_note(note_id: int, user: User, session: Session) -> Note:
    note = session.get(Note, note_id)
    if note is None or note.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notask introuvable")
    return note


def _check_color(color: Optional[str]) -> None:
    if color is not None and color not in COLORS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Couleur inconnue : {color}")


def _check_icon(icon: Optional[str]) -> None:
    if icon is not None and icon not in ICON_KEYS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Icône inconnue : {icon}")


def _check_labels(label_ids: Optional[List[int]], user: User, session: Session) -> None:
    """Vérifie que chaque libellé référencé appartient bien à l'utilisateur."""
    if not label_ids:
        return
    owned = set(session.exec(
        select(Label.id).where(Label.user_id == user.id, Label.id.in_(label_ids))
    ).all())
    unknown = set(label_ids) - owned
    if unknown:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Libellé(s) inconnu(s) : {sorted(unknown)}")


def _replace_items(note: Note, items: List[NoteItemIn], session: Session) -> List[NoteItem]:
    """Remplace les lignes en conservant les échéances des lignes réutilisées.
    Renvoie les nouvelles lignes (avec leur id, après flush) pour permettre à
    l'appelant de déclencher leur synchro Google Calendar si besoin."""
    for existing in session.exec(select(NoteItem).where(NoteItem.note_id == note.id)).all():
        session.delete(existing)
    session.flush()
    created = []
    for position, item in enumerate(items):
        row = NoteItem(
            note_id=note.id,
            text=item.text,
            checked=item.checked,
            due_at=item.due_at,
            calendar_title=item.calendar_title,
            position=position,
        )
        session.add(row)
        created.append(row)
    session.flush()
    return created


def _purge_note(note: Note, session: Session) -> None:
    """Suppression définitive et irréversible : lignes, pièces jointes (fichier
    disque + ligne), historique complet (voir delete_all_versions), puis la
    note elle-même. Ne fait pas de commit — à la charge de l'appelant."""
    for item in session.exec(select(NoteItem).where(NoteItem.note_id == note.id)).all():
        session.delete(item)
    for att in session.exec(select(NoteAttachment).where(NoteAttachment.note_id == note.id)).all():
        path = ATTACH_DIR / att.storage_name
        if path.exists():
            path.unlink()
        session.delete(att)
    delete_all_versions(note.id, session)
    session.delete(note)


def _purge_expired_trash(user: User, session: Session) -> None:
    """Purge silencieusement les notes en corbeille depuis plus de
    TRASH_RETENTION_DAYS. Pas de tâche planifiée dans cette appli : ce
    contrôle est fait "à la volée" à chaque list_notes(), donc au pire au
    prochain chargement de l'utilisateur plutôt qu'à la seconde près."""
    cutoff = utcnow() - timedelta(days=TRASH_RETENTION_DAYS)
    expired = session.exec(
        select(Note).where(
            Note.user_id == user.id,
            Note.trashed_at.is_not(None),
            Note.trashed_at < cutoff,
        )
    ).all()
    if not expired:
        return
    for note in expired:
        _purge_note(note, session)
    session.commit()


@router.get("", response_model=List[NoteOut])
def list_notes(
    request: Request,
    archived: bool = Query(default=False, description="Afficher les notasks archivées"),
    trashed: bool = Query(default=False, description="Afficher la corbeille au lieu des notasks normales"),
    q: Optional[str] = Query(default=None, description="Recherche titre et contenu"),
    label: Optional[int] = Query(default=None, description="Filtrer par identifiant de libellé"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _purge_expired_trash(user, session)
    # Adresse publique de l'installation, relevée ici parce que la synchro
    # Google tourne sans contexte de requête et ne peut pas la deviner (elle
    # sert au lien « Ouvrir dans notask » ajouté aux événements). N'écrit que
    # si la valeur a changé, voir remember_base_url().
    gcal.remember_base_url(session, str(request.base_url))
    # Tirage Google Calendar -> notask (voir google_calendar.pull_changes) :
    # ne répercute que les dates modifiées/événements supprimés côté Google,
    # ne fait rien si aucun compte Google n'est connecté. Même schéma
    # paresseux que la purge de corbeille ci-dessus.
    gcal.pull_changes(user, session)

    if trashed:
        stmt = select(Note).where(Note.user_id == user.id, Note.trashed_at.is_not(None))
    else:
        # Une note en corbeille disparaît de toutes les autres vues, y
        # compris les archives.
        stmt = select(Note).where(
            Note.user_id == user.id, Note.archived == archived, Note.trashed_at.is_(None)
        )
    if q:
        stmt = stmt.where(
            Note.title.contains(q) | Note.description.contains(q) | Note.content.contains(q)
        )
    if trashed:
        # Les plus récemment mises à la corbeille en premier.
        notes = session.exec(stmt.order_by(Note.trashed_at.desc())).all()
    else:
        # Épinglées d'abord, puis par ordre manuel (glisser-déposer) ; les
        # notes antérieures à l'ajout de `position` partagent toutes la
        # valeur 0 et retombent alors sur la date de modification, pour ne
        # pas se mélanger.
        notes = session.exec(
            stmt.order_by(Note.pinned.desc(), Note.position.desc(), Note.updated_at.desc())
        ).all()
    if label is not None:
        notes = [n for n in notes if label in (n.label_ids or [])]
    return notes


@router.post("", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
def create_note(
    payload: NoteCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _check_color(payload.color)
    _check_icon(payload.icon)
    _check_labels(payload.label_ids, user, session)
    note = Note(**payload.model_dump(exclude={"items"}), user_id=user.id)
    session.add(note)
    session.flush()
    items = _replace_items(note, payload.items, session)
    session.commit()
    session.refresh(note)

    # Synchro Google Calendar (voir app/google_calendar.py) : n'a d'effet
    # que si l'utilisateur a un compte Google connecté et que due_at/
    # calendar_title sont posés ; sans quoi ne fait rien. Volontairement
    # après le commit ci-dessus : la notask est déjà sauvegardée avant
    # même de tenter Google, un souci Google ne doit jamais faire échouer
    # la création de la notask elle-même.
    gcal.sync_note(note, session)
    for item in items:
        gcal.sync_item(item, note, session)
    return note


@router.get("/{note_id}", response_model=NoteOut)
def get_note(
    note_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return _owned_note(note_id, user, session)


@router.patch("/{note_id}", response_model=NoteOut)
def update_note(
    note_id: int,
    payload: NoteUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    note = _owned_note(note_id, user, session)
    data = payload.model_dump(exclude_unset=True)
    _check_color(data.get("color"))
    _check_icon(data.get("icon"))
    _check_labels(data.get("label_ids"), user, session)

    # Sans échéance, une note n'est pas une tâche : rien à terminer.
    if data.get("done") and (data.get("due_at", note.due_at) is None):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Une notask sans échéance ne peut pas être marquée terminée",
        )

    if "done" in data and data["done"] != note.done:
        note.done_at = utcnow() if data["done"] else None

    # Retirer l'échéance annule aussi l'état terminé.
    if "due_at" in data and data["due_at"] is None:
        note.done = False
        note.done_at = None
        data.pop("done", None)

    items = data.pop("items", None)
    for key, value in data.items():
        setattr(note, key, value)

    new_items = None
    if items is not None:
        new_items = _replace_items(note, [NoteItemIn(**i) for i in items], session)

    # Le titre en clair (calendar_title) n'a de sens que tant que la notask
    # est effectivement synchronisable — le vider dès qu'elle ne l'est plus
    # évite qu'un titre en clair traîne en base au-delà du strict nécessaire.
    if note.due_at is None or note.archived:
        note.calendar_title = None

    note.updated_at = utcnow()
    session.add(note)
    session.commit()
    session.refresh(note)

    gcal.sync_note(note, session)
    if new_items is not None:
        for item in new_items:
            gcal.sync_item(item, note, session)
    return note


@router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_note(
    note_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Double rôle, comme une corbeille classique (ex. Gmail) : la première
    suppression met la note de côté (trashed_at), la seconde — appelée
    depuis la corbeille elle-même, sur une note déjà mise de côté — est
    définitive. Évite d'ajouter une route dédiée juste pour ce second cas."""
    note = _owned_note(note_id, user, session)
    if note.trashed_at is None:
        note.trashed_at = utcnow()
        session.add(note)
        session.commit()
        gcal.sync_note(note, session)  # supprime l'événement Google lié, si présent
        return
    _purge_note(note, session)
    session.commit()


@router.post("/{note_id}/restore", response_model=NoteOut)
def restore_note(
    note_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    note = _owned_note(note_id, user, session)
    if note.trashed_at is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cette notask n'est pas dans la corbeille")
    note.trashed_at = None
    session.add(note)
    session.commit()
    session.refresh(note)
    gcal.sync_note(note, session)  # recrée l'événement Google si due_at/calendar_title toujours posés
    return note


# -------------------- Lignes à cocher, une par une --------------------
# Utile pour dater une ligne ou la cocher sans réécrire toute la note.

@router.patch("/{note_id}/items/{item_id}", response_model=NoteItemOut)
def update_item(
    note_id: int,
    item_id: int,
    payload: NoteItemUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    note = _owned_note(note_id, user, session)
    item = session.get(NoteItem, item_id)
    if item is None or item.note_id != note_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ligne introuvable")

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(item, key, value)
    if item.due_at is None:
        item.calendar_title = None  # cf. update_note : hygiène, pas de titre en clair sans échéance

    session.add(item)
    session.commit()
    session.refresh(item)
    gcal.sync_item(item, note, session)
    return item
