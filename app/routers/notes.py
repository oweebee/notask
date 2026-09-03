"""Notes — l'unique objet créable.

Une échéance posée sur une note, ou sur l'une de ses cases à cocher, en fait
une tâche visible dans la vue Tâches. Voir app/routers/tasks.py.
"""

from datetime import timedelta
from typing import List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlmodel import Session, select

from app import google_calendar as gcal
from app.db import get_session
from app.deps import get_current_user
from app.models import (
    RECUR_VALUES,
    ArchivedItemOut,
    TrashedItemOut,
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
    next_recurrence,
    utcnow,
)
from app.routers.attachments import ATTACH_DIR
from app.routers.note_versions import delete_all_versions
from app.routers.settings import fuseau_utilisateur

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
    # Lot crypto / serveurs / informatique (55 -> 75).
    "server", "database", "cloudserver", "network", "terminal", "code",
    "bug", "shield", "vpn", "wifi", "bitcoin", "ethereum", "wallet",
    "chart", "cpu", "backup", "docker", "api", "password", "monitoring",
    # Lot développement + gaming (75 -> 95).
    "git", "branch", "bracket", "rocket", "package", "gamepad", "joystick",
    "dice", "trophy", "console", "ghost", "headset", "keyboard", "mouse",
    "sword", "potion", "achievement", "vr", "medal", "stream",
    # Trois de plus par thème (95 -> 104).
    "firewall", "certificate", "router",      # crypto / serveurs / IT
    "merge", "test", "build",                 # développement
    "arcade", "chess", "quest",               # gaming
    # Encore trois par thème (104 -> 113).
    "storage", "ethernet", "loadbalancer",    # crypto / serveurs / IT
    "commit", "issue", "pipeline",            # développement
    "coin", "puzzle", "cards",                # gaming
    # Nouveaux thèmes (113 -> 137).
    "folder", "kanban", "clipboard", "tag", "pin", "filter",          # organisation
    "arrowup", "arrowdown", "arrowleft", "arrowright",
    "arrowcycle", "arrowsplit",                                       # flèches
    "plus", "minus", "check", "cross", "info", "question",            # symboles
    "dotred", "dotorange", "dotyellow", "dotgreen", "dotblue",
    "dotpurple",                                                      # ronds
    # Complément pour porter chaque thème à 20 icônes (137 -> 227).
    "dotpink", "dotteal", "dotcyan", "dotindigo", "dotbrown", "dotgrey",
    "dotlime", "dotamber", "dotdeeporange", "dotlightblue",
    "dotlightgreen", "dotdeeppurple", "dotbluegrey", "dotwhite",
    "arrowupright", "arrowdownright", "arrowupleft", "arrowdownleft",
    "arrowdoubleup", "arrowdoubledown", "arrowexpand", "arrowcollapse",
    "arrowswap", "arrowundo", "arrowredo", "arrowexternal",
    "arrowdownload", "arrowupload",
    "exclamation", "asterisk", "hash", "at", "percent", "euro", "dollar",
    "ellipsis", "equal", "infinity", "bolt", "sparkle", "ban", "copyright",
    "calendar", "list", "grid", "inbox", "bookmark", "link", "attachment",
    "timeline", "sort", "note", "boite", "planning", "priorite",
    "dossierlock",
    "leaf", "mountain", "wave", "snow", "rain", "fire", "cactus",
    "mushroom", "butterfly", "starnight", "wind",
    "bank", "creditcard", "invoice", "safe", "coins", "trendup",
    "trenddown", "piechart", "calculator", "receipt", "exchange",
    "ledger", "piggybank", "goldbar", "contract", "nft",
    "fonction", "variable", "regex", "refactor", "review", "deploy",
    "docs", "trombone",
    # Événements & occasions
    "tv", "interruption", "urgente", "anniversaire", "fete", "vacances",
    # Fruits
    "fraise", "pomme", "banane", "orange", "raisin", "pasteque",
    "citron", "poire", "peche", "cerise", "mangue", "ananas",
    "myrtille", "kiwi", "melon", "grenade",
    # Légumes
    "carotte", "brocoli", "mais", "poivron", "oignon", "ail",
    "concombre", "pomdeterre", "laitue", "aubergine", "haricot",
    "tomate", "pois",
    # Jardin
    "arrosoir", "bouquet", "tournesol", "tulipe", "rose", "herbe",
    "plantule", "plante2", "ble", "graine", "feuillage", "champarden",
    # Animaux
    "chat", "chien", "lapin", "ours", "vache", "cochon", "mouton",
    "cheval", "renard", "lion", "tigre", "singe", "elephant", "tortue",
    "serpent", "pingouin", "canard", "grenouille", "loup", "abeille",
    "dauphin", "baleine", "pieuvre", "crabe", "papillon2",
    # Smileys
    "smile", "laugh", "love", "cool", "think", "sleep", "cry", "angry",
    "explode", "sweat", "party2", "happy", "salute", "plead", "huff",
    "angel", "starstruck", "smirk", "weary", "grimace",
    # Gestes
    "thumbup", "thumbdown", "okhand", "fuck", "peace", "rock", "clap",
    "raise", "stop", "crossed", "point", "callme", "lovehands", "fist",
    "wave2",
    "film", "series", "discord", "teams", "word", "excel", "cart", "bite", "nichons", "chartreuse", "hellfest",
    "electrique", "plex",
    "steam", "epic", "gog", "ubisoft", "blizzard",
    "playstation", "xbox", "nintendo", "android", "apple",
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


def _check_recur(recur: Optional[str]) -> None:
    if recur is not None and recur not in RECUR_VALUES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Récurrence inconnue : {recur}")


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


def _replace_items(
    note: Note, items: List[NoteItemIn], session: Session
) -> Tuple[List[NoteItem], List[str]]:
    """Met à jour les lignes d'une notask EN CONSERVANT leur identifiant.

    Une ligne envoyée avec un `id` déjà connu est modifiée sur place ; une
    ligne sans `id` est créée ; celles qui ne figurent plus dans l'envoi sont
    supprimées.

    Renvoie deux choses : la liste finale des lignes, dans l'ordre, pour que
    l'appelant déclenche leur synchro Google Calendar ; et les identifiants
    des événements Google devenus orphelins, à retirer de l'agenda puisque
    leur ligne, elle, n'existe plus.

    ---

    La version précédente supprimait TOUTES les lignes puis les recréait à
    chaque enregistrement. Deux conséquences, dont une franchement mauvaise :

    1. **Elle dupliquait les événements Google Calendar.** Une ligne recréée
       repart sans `google_event_id` ; `sync_item` en conclut qu'elle n'a pas
       encore d'événement et en crée un NOUVEAU, sans supprimer l'ancien, qui
       reste orphelin dans l'agenda. Chaque enregistrement d'une notask
       contenant une ligne datée ajoutait donc un doublon.
    2. **Les identifiants de lignes changeaient à chaque sauvegarde**, ce qui
       interdisait d'y faire référence ailleurs — notamment depuis le contenu
       d'une notask, condition des notasks mixtes (texte et cases mêlés).

    Le champ `id` de NoteItemIn existait déjà dans le schéma, il n'était
    simplement jamais exploité.
    """
    existantes = {
        row.id: row
        for row in session.exec(select(NoteItem).where(NoteItem.note_id == note.id)).all()
    }

    finales: List[NoteItem] = []
    vues: set = set()

    for position, item in enumerate(items):
        _check_recur(item.recur)
        row = existantes.get(item.id) if item.id is not None else None

        if row is not None:
            # Mise à jour sur place : `google_event_id`, `archived` et
            # `trashed_at` ne sont pas touchés — ils appartiennent à la ligne,
            # pas à ce que le client vient d'envoyer.
            row.text = item.text
            row.checked = item.checked
            row.due_at = item.due_at
            row.due_end_at = item.due_end_at if item.due_at else None
            row.all_day = item.all_day if item.due_at else False
            row.recur = item.recur if item.due_at else None
            row.calendar_title = item.calendar_title
            row.position = position
            vues.add(row.id)
        else:
            row = NoteItem(
                note_id=note.id,
                text=item.text,
                checked=item.checked,
                due_at=item.due_at,
                due_end_at=item.due_end_at if item.due_at else None,
                all_day=item.all_day if item.due_at else False,
                recur=item.recur if item.due_at else None,
                calendar_title=item.calendar_title,
                position=position,
            )
        session.add(row)
        finales.append(row)

    # Lignes absentes de l'envoi : réellement supprimées par l'utilisateur.
    # On relève leur événement Google AVANT de les détruire — la ligne
    # disparaissant, plus rien ensuite ne saurait qu'un événement lui
    # correspondait, et il resterait orphelin dans l'agenda. C'était déjà le
    # cas avec l'ancienne implémentation, pour TOUTES les lignes.
    orphelins: List[str] = []
    for ancien_id, row in existantes.items():
        if ancien_id in vues:
            continue
        if row.google_event_id:
            orphelins.append(row.google_event_id)
        session.delete(row)

    session.flush()
    return finales, orphelins


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


def archiver_si_tout_coche(note: Note, session: Session) -> bool:
    """Archive une liste à cocher dont TOUTES les lignes sont cochées, et la
    désarchive dès qu'une ligne est décochée.

    Placé côté SERVEUR et non dans le client : une case peut être cochée
    depuis la mosaïque, depuis l'édition rapide, depuis la vue des échéances,
    ou depuis un widget d'écran d'accueil Android. Le faire côté client
    obligerait à répéter la même règle dans chacun de ces chemins, avec la
    certitude d'en oublier un.

    Le mouvement est RÉVERSIBLE, volontairement : décocher une ligne d'une
    notask archivée la fait ressortir des archives. Sans cela, corriger une
    case cochée par erreur laisserait la notask coincée dans les archives
    sans que rien ne l'explique.

    Ne fait rien pour une notask sans aucune case (elle n'a rien à terminer),
    ni pour une notask en corbeille. Aucun commit : à la charge de l'appelant.

    Rien ici ne touche aux ÉCHÉANCES : une ligne datée garde son `due_at` et
    son `google_event_id`, et continue de remonter dans « Notasks prévues » et
    dans le widget Android exactement comme avant. Archiver la notask qui la
    porte ne la retire pas de l'agenda.

    Renvoie True si l'état d'archivage a changé.
    """
    if note.trashed_at is not None:
        return False

    # Aucune condition sur `is_checklist` ni sur le contenu : la règle vaut
    # pour TOUTE notask qui porte au moins une case, texte et images compris.
    #
    # Ce point a changé en cours de route, décision de l'utilisateur. La
    # version précédente refusait d'archiver une notask « mixte », au motif
    # que les cases n'y sont qu'une partie du propos. Il a tranché l'inverse,
    # et c'est plus simple à expliquer : des cases toutes cochées veulent dire
    # « c'est fini », quoi qu'il y ait autour. Le mouvement reste réversible
    # (décocher une case ressort la notask des archives), donc l'erreur, si
    # c'en est une, ne coûte qu'un clic.
    #
    # Une notask SANS aucune case n'est pas concernée : `if not lignes` plus
    # bas s'en charge. Sans quoi toute notask de texte libre s'archiverait
    # toute seule, « toutes ses cases » étant cochées par vacuité.
    lignes = session.exec(
        select(NoteItem).where(
            NoteItem.note_id == note.id,
            # Une ligne mise de côté seule ne compte pas : elle a justement
            # quitté la liste (voir NoteItem.archived / trashed_at).
            NoteItem.archived == False,  # noqa: E712 — SQLAlchemy, pas un `is`
            NoteItem.trashed_at.is_(None),
        )
    ).all()
    if not lignes:
        return False

    tout_coche = all(ligne.checked for ligne in lignes)
    if tout_coche == note.archived:
        return False

    note.archived = tout_coche
    note.updated_at = utcnow()
    session.add(note)
    return True


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
    for note in expired:
        _purge_note(note, session)
    if expired:
        session.commit()

    # Même retenue, mais pour une LIGNE mise seule à la corbeille (notask
    # parente toujours active) : sans ce second passage, ces lignes ne
    # seraient jamais purgées puisqu'elles ne dépendent d'aucune Note
    # elle-même expirée. Jointure sur Note.user_id : NoteItem ne porte pas
    # l'utilisateur directement.
    expired_items = session.exec(
        select(NoteItem)
        .join(Note, NoteItem.note_id == Note.id)
        .where(
            Note.user_id == user.id,
            NoteItem.trashed_at.is_not(None),
            NoteItem.trashed_at < cutoff,
        )
    ).all()
    if not expired_items:
        return
    for item in expired_items:
        session.delete(item)
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


@router.get("/archived-items", response_model=List[ArchivedItemOut])
def list_archived_items(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Lignes à cocher archivées seules (voir NoteItem.archived), affichées
    dans les Archives comme des lignes et non comme des cartes — la notask
    parente, elle, reste active.

    Déclaré AVANT la route "/{note_id}" : FastAPI teste les routes dans
    l'ordre de déclaration, et "/{note_id}" absorberait sinon
    "archived-items" en tentant de le lire comme un identifiant.
    """
    rows = session.exec(
        select(NoteItem, Note)
        .join(Note, NoteItem.note_id == Note.id)
        .where(
            Note.user_id == user.id,
            NoteItem.archived == True,  # noqa: E712 — SQLAlchemy, pas un `is`
            NoteItem.trashed_at.is_(None),
            # Une notask entière en corbeille emporte ses lignes hors de vue.
            Note.trashed_at.is_(None),
        )
    ).all()
    return [
        ArchivedItemOut(
            id=item.id, note_id=note.id, text=item.text, checked=item.checked,
            due_at=item.due_at, due_end_at=item.due_end_at, all_day=item.all_day,
            color=note.color, icon=note.icon, note_title=note.title,
        )
        for item, note in rows
    ]


@router.get("/trashed-items", response_model=List[TrashedItemOut])
def list_trashed_items(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Lignes à cocher mises SEULES à la corbeille (voir NoteItem.trashed_at),
    pendant de list_archived_items() côté Corbeille — la notask parente,
    elle, reste active. Une ligne dont la notask ENTIÈRE est à la corbeille
    n'apparaît pas ici : elle est déjà visible, imbriquée, dans la carte de
    cette notask en Corbeille.

    Déclarée avant "/{note_id}" pour la même raison qu'archived-items."""
    _purge_expired_trash(user, session)
    rows = session.exec(
        select(NoteItem, Note)
        .join(Note, NoteItem.note_id == Note.id)
        .where(
            Note.user_id == user.id,
            NoteItem.trashed_at.is_not(None),
            Note.trashed_at.is_(None),
        )
    ).all()
    return [
        TrashedItemOut(
            id=item.id, note_id=note.id, text=item.text, checked=item.checked,
            trashed_at=item.trashed_at, color=note.color, icon=note.icon,
            note_title=note.title,
        )
        for item, note in rows
    ]


@router.post("", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
def create_note(
    payload: NoteCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _check_color(payload.color)
    _check_icon(payload.icon)
    _check_recur(payload.recur)
    _check_labels(payload.label_ids, user, session)
    note = Note(**payload.model_dump(exclude={"items"}), user_id=user.id)
    if note.due_at is None:
        note.all_day = False
        note.recur = None
    session.add(note)
    session.flush()
    # Pas d'orphelins possibles à la création : la notask vient de naître, il
    # n'existait aucune ligne avant, donc aucun événement Google à nettoyer.
    items, _ = _replace_items(note, payload.items, session)
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
    _check_recur(data.get("recur"))
    _check_labels(data.get("label_ids"), user, session)

    # Sans échéance, une note n'est pas une tâche : rien à terminer.
    if data.get("done") and (data.get("due_at", note.due_at) is None):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Une notask sans échéance ne peut pas être marquée terminée",
        )

    # État AVANT application de `data` : sert plus bas à ne reprogrammer une
    # notask récurrente que si elle vient RÉELLEMENT d'être cochée dans cet
    # envoi. Un simple `if note.done` testerait un état, pas une transition —
    # ajouter une récurrence à une notask déjà terminée (elle garde done=True,
    # la boîte d'édition n'envoie pas `done`) l'aurait alors fait sauter d'une
    # semaine sans que l'utilisateur n'ait rien coché.
    etait_done = note.done

    if "done" in data and data["done"] != note.done:
        note.done_at = utcnow() if data["done"] else None

    # Retirer l'échéance annule aussi l'état terminé et toute récurrence :
    # une récurrence n'a de sens qu'adossée à une échéance.
    if "due_at" in data and data["due_at"] is None:
        note.done = False
        note.done_at = None
        data.pop("done", None)
        # Une fin de plage sans début n'a pas de sens : elle disparaît avec
        # l'échéance, que le client ait pensé à l'envoyer à None ou non.
        data["due_end_at"] = None
        data["all_day"] = False
        data["recur"] = None

    items = data.pop("items", None)
    for key, value in data.items():
        setattr(note, key, value)

    # État des cases AVANT remplacement : sert plus bas à ne déclencher
    # l'archivage automatique que si une case a réellement bougé.
    coches_avant = {ligne.id: ligne.checked for ligne in note.items}

    new_items = None
    orphelins: List[str] = []
    if items is not None:
        new_items, orphelins = _replace_items(note, [NoteItemIn(**i) for i in items], session)

    # Le titre en clair (calendar_title) n'a de sens que tant que la notask
    # est effectivement synchronisable — le vider dès qu'elle ne l'est plus
    # évite qu'un titre en clair traîne en base au-delà du strict nécessaire.
    if note.due_at is None or note.archived:
        note.calendar_title = None
    if note.due_at is None:
        note.due_end_at = None
        note.all_day = False

    note.updated_at = utcnow()
    session.add(note)
    session.commit()

    # Archivage automatique — voir archiver_si_tout_coche. Trois conditions,
    # chacune pour une raison différente :
    #
    # - `new_items is not None` : les lignes ont été envoyées. Sans ça, un
    #   simple changement de couleur suffirait à ranger ou ressortir une
    #   notask.
    # - `"archived" not in data` : l'utilisateur n'a pas archivé ou désarchivé
    #   lui-même dans la même requête. Sa décision prime sur la règle.
    # - `coches_changees` : une case a RÉELLEMENT bougé.
    #
    # La troisième a été ajoutée après coup, et c'est la plus importante des
    # trois. Sans elle, la règle n'est pas un déclenchement mais un invariant
    # que le serveur rétablit à chaque écriture : une notask dont toutes les
    # cases sont cochées, qu'on ressort des archives à la main, s'y retrouve
    # renvoyée au premier enregistrement suivant — il suffit de l'ouvrir et de
    # la refermer. Impossible à contourner, et incompréhensible vu de l'écran.
    # Le défaut existait déjà pour les listes à cocher ; il serait devenu
    # criant maintenant que la règle vaut pour toute notask portant des cases.
    #
    # Une case ajoutée ou retirée compte comme un changement : passer de « deux
    # cochées sur trois » à « deux sur deux » en supprimant la dernière, c'est
    # bien terminer la liste.
    coches_apres = {ligne.id: ligne.checked for ligne in (new_items or [])}
    coches_changees = coches_avant != coches_apres

    if new_items is not None and "archived" not in data and coches_changees:
        if archiver_si_tout_coche(note, session):
            session.commit()

    session.refresh(note)

    gcal.sync_note(note, session)
    if new_items is not None:
        for item in new_items:
            gcal.sync_item(item, note, session)

    # Récurrence (voir next_recurrence dans models.py) : UNIQUEMENT au moment
    # où la notask/ligne vient d'être cochée terminée dans CET envoi — jamais
    # avant, et jamais sur une notask déjà terminée qu'on se contente de
    # réenregistrer (d'où `not etait_done`, voir plus haut). Le sync ci-dessus
    # a déjà retiré l'ancien événement Google (une tâche cochée quitte
    # l'agenda) ; on décoche, on avance l'échéance, et un second sync crée un
    # nouvel événement à la date suivante.
    # Fuseau de l'utilisateur : décaler « d'une semaine » veut dire « même
    # heure locale », pas « + 7 × 24 h » (voir next_recurrence). Lu À LA
    # DEMANDE et mémorisé, jamais d'office : cette fonction est le chemin
    # d'écriture le plus fréquenté de l'appli (enregistrement d'une notask,
    # épinglage, réordonnancement, changement de couleur…) et il serait
    # absurde de lui coûter une requête de plus à chaque passage pour un
    # réglage qui ne sert qu'aux rares reprogrammations ci-dessous.
    _fuseau: List[Optional[str]] = []

    def fuseau() -> Optional[str]:
        if not _fuseau:
            _fuseau.append(fuseau_utilisateur(note.user_id, session))
        return _fuseau[0]

    if note.done and not etait_done and note.recur and note.due_at is not None:
        nouveau_due, nouveau_fin = next_recurrence(
            note.due_at, note.due_end_at, note.recur, fuseau(), note.all_day)
        note.done = False
        note.done_at = None
        note.due_at = nouveau_due
        note.due_end_at = nouveau_fin
        note.updated_at = utcnow()
        session.add(note)
        session.commit()
        session.refresh(note)
        gcal.sync_note(note, session)

    if new_items is not None:
        item_reprogramme = False
        for item in new_items:
            # Même règle de TRANSITION que pour la notask ci-dessus, appuyée
            # sur `coches_avant` (relevé avant remplacement des lignes) : la
            # ligne existait déjà, elle n'était pas cochée, elle l'est
            # maintenant. Une ligne simplement réenregistrée en l'état, ou
            # créée déjà cochée, n'est donc pas reprogrammée.
            vient_detre_cochee = item.id in coches_avant and not coches_avant[item.id]
            if item.checked and vient_detre_cochee and item.recur and item.due_at is not None:
                nouveau_due, nouveau_fin = next_recurrence(
                    item.due_at, item.due_end_at, item.recur, fuseau(), item.all_day)
                item.checked = False
                item.due_at = nouveau_due
                item.due_end_at = nouveau_fin
                session.add(item)
                item_reprogramme = True
        if item_reprogramme:
            session.commit()
            # Peut faire ressortir la notask des archives : l'archivage
            # automatique ci-dessus l'y a peut-être rangée à l'instant parce
            # que toutes les cases étaient cochées, mais celle(s) qui viennent
            # de se reprogrammer ne le sont plus.
            if archiver_si_tout_coche(note, session):
                session.commit()
            for item in new_items:
                session.refresh(item)
                gcal.sync_item(item, note, session)

    # Événements des lignes réellement supprimées. Après le commit : leur
    # ligne n'existe plus en base, il ne reste qu'à nettoyer l'agenda.
    for event_id in orphelins:
        gcal.supprimer_evenement_orphelin(note.user_id, event_id, session)
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

@router.delete("/{note_id}/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item(
    note_id: int,
    item_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Suppression DÉFINITIVE d'une ligne déjà mise seule à la corbeille
    (voir update_item, payload {trashed: true}) — pendant de delete_note()
    pour une ligne plutôt qu'une notask entière. Pas de double rôle ici,
    contrairement à delete_note : la mise à la corbeille passe déjà par le
    PATCH, cette route-ci ne fait donc jamais que la purge.

    Aucun nettoyage Google Calendar à faire ici : sync_item() a déjà retiré
    l'événement lié au moment où trashed_at a été posé (should_have_event
    en dépend), voir update_item."""
    note = _owned_note(note_id, user, session)
    item = session.get(NoteItem, item_id)
    if item is None or item.note_id != note_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ligne introuvable")
    if item.trashed_at is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cette ligne n'est pas dans la corbeille")
    session.delete(item)
    session.commit()


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

    data = payload.model_dump(exclude_unset=True)
    _check_recur(data.get("recur"))
    # Cf. update_note : état AVANT application, pour ne reprogrammer que sur
    # une vraie transition "décochée -> cochée".
    etait_coche = item.checked
    # `trashed` est un booléen côté API, converti ici en horodatage (voir
    # NoteItemUpdate) : il ne correspond à aucun attribut du modèle et
    # ferait échouer le setattr générique s'il y restait.
    if "trashed" in data:
        item.trashed_at = utcnow() if data.pop("trashed") else None
    for key, value in data.items():
        setattr(item, key, value)
    if item.due_at is None:
        item.calendar_title = None  # cf. update_note : hygiène, pas de titre en clair sans échéance
        item.due_end_at = None      # une fin de plage sans début n'a pas de sens
        item.all_day = False
        item.recur = None           # cf. update_note : une récurrence sans échéance n'a pas de sens

    session.add(item)
    session.commit()

    # Après le commit de la ligne, sinon le comptage porterait sur l'état
    # d'avant. Voir archiver_si_tout_coche : cocher la dernière case archive
    # la notask, en décocher une la fait ressortir.
    if archiver_si_tout_coche(note, session):
        session.commit()

    session.refresh(item)
    gcal.sync_item(item, note, session)

    # Récurrence (voir next_recurrence dans models.py) : UNIQUEMENT au moment
    # où la ligne vient d'être cochée terminée dans CET envoi — jamais avant.
    # Le sync ci-dessus a déjà retiré l'ancien événement Google (should_have_
    # event devient False tant que la ligne est cochée) ; on la décoche, on
    # avance sa date, et un second sync en crée un nouveau à la date suivante
    # plutôt que de faire glisser le même événement.
    if item.checked and not etait_coche and item.recur and item.due_at is not None:
        nouveau_due, nouveau_fin = next_recurrence(
            item.due_at, item.due_end_at, item.recur,
            fuseau_utilisateur(note.user_id, session), item.all_day)
        item.checked = False
        item.due_at = nouveau_due
        item.due_end_at = nouveau_fin
        session.add(item)
        session.commit()
        # Peut faire ressortir la notask des archives si archiver_si_tout_coche
        # venait de l'y ranger à l'instant : cette ligne-ci ne l'est plus.
        if archiver_si_tout_coche(note, session):
            session.commit()
        session.refresh(item)
        gcal.sync_item(item, note, session)

    return item
