"""
app/mcp_server.py
Serveur MCP intégré à FastAPI. Monté à /mcp dans main.py.
Auth : Authorization: Bearer <NOTASK_MCP_KEY> (variable d'env Coolify).
Accès direct SQLite via engine (même DB que l'app).
ATTENTION : données titre/description/contenu/lignes = chiffrées côté client → opaques ici.
"""
import json
import os
from datetime import datetime
from typing import Optional

from sqlmodel import Session, select

from app.db import engine
from app.models import Label, Note, NoteItem, utcnow

try:
    from mcp.server.mcpserver import MCPServer
except ImportError:
    from mcp.server.fastmcp import FastMCP as MCPServer  # mcp < 2.x

mcp = MCPServer("notask")

_USER_ID = int(os.getenv("NOTASK_MCP_USER_ID", "1"))


# ─── helpers ──────────────────────────────────────────────────────────────────

def _dt(v: Optional[datetime]) -> Optional[str]:
    return v.isoformat() if v else None


def _note_dict(note: Note) -> dict:
    return {
        "id": note.id,
        "title": note.title,
        "description": note.description,
        "content": note.content,
        "color": note.color,
        "icon": note.icon,
        "pinned": note.pinned,
        "archived": note.archived,
        "done": note.done,
        "trashed": note.trashed_at is not None,
        "due_at": _dt(note.due_at),
        "recur": note.recur,
        "label_ids": note.label_ids or [],
        "updated_at": _dt(note.updated_at),
    }


def _item_dict(item: NoteItem) -> dict:
    return {
        "id": item.id,
        "text": item.text,
        "checked": item.checked,
        "position": item.position,
        "due_at": _dt(item.due_at),
        "recur": item.recur,
    }


# ─── outils ───────────────────────────────────────────────────────────────────

@mcp.tool()
def list_notes(
    pinned: Optional[bool] = None,
    archived: Optional[bool] = None,
    trashed: Optional[bool] = None,
    color: Optional[str] = None,
    label_id: Optional[int] = None,
    q: Optional[str] = None,
) -> str:
    """Liste les notes (filtres optionnels : pinned, archived, trashed, color, label_id, q)."""
    with Session(engine) as session:
        stmt = select(Note).where(Note.user_id == _USER_ID)
        if pinned is not None:
            stmt = stmt.where(Note.pinned == pinned)
        if archived is not None:
            stmt = stmt.where(Note.archived == archived)
        if trashed is True:
            stmt = stmt.where(Note.trashed_at.isnot(None))
        elif trashed is False or trashed is None:
            stmt = stmt.where(Note.trashed_at.is_(None))
        if color:
            stmt = stmt.where(Note.color == color)
        notes = session.exec(stmt).all()
        if label_id is not None:
            notes = [n for n in notes if label_id in (n.label_ids or [])]
        return json.dumps([_note_dict(n) for n in notes], ensure_ascii=False)


@mcp.tool()
def get_note(note_id: int) -> str:
    """Retourne le détail d'une note avec ses lignes (items)."""
    with Session(engine) as session:
        note = session.get(Note, note_id)
        if not note or note.user_id != _USER_ID:
            return json.dumps({"error": "not found"})
        data = _note_dict(note)
        data["items"] = [_item_dict(i) for i in note.items]
        return json.dumps(data, ensure_ascii=False)


@mcp.tool()
def create_note(
    title: str = "",
    content: str = "",
    color: str = "default",
    pinned: bool = False,
    due_at: Optional[str] = None,
    icon: Optional[str] = None,
    items: Optional[str] = None,
) -> str:
    """Crée une note. items = JSON string [{text, checked, due_at?, recur?}].
    Attention : texte stocké EN CLAIR (non chiffré), contrairement au client."""
    with Session(engine) as session:
        due = datetime.fromisoformat(due_at) if due_at else None
        note = Note(
            user_id=_USER_ID,
            title=title,
            content=content,
            description="",
            color=color,
            pinned=pinned,
            due_at=due,
            icon=icon,
            is_checklist=False,
        )
        session.add(note)
        session.flush()
        if items:
            try:
                for pos, it in enumerate(json.loads(items)):
                    session.add(NoteItem(
                        note_id=note.id,
                        text=it.get("text", ""),
                        checked=it.get("checked", False),
                        position=pos,
                        due_at=datetime.fromisoformat(it["due_at"]) if it.get("due_at") else None,
                        recur=it.get("recur"),
                    ))
            except Exception as e:
                return json.dumps({"error": f"items parse: {e}"})
        session.commit()
        return json.dumps({"id": note.id, "created": True})


@mcp.tool()
def update_note(
    note_id: int,
    title: Optional[str] = None,
    content: Optional[str] = None,
    color: Optional[str] = None,
    pinned: Optional[bool] = None,
    archived: Optional[bool] = None,
    due_at: Optional[str] = None,
    icon: Optional[str] = None,
) -> str:
    """Modifie une note existante (seuls les champs fournis sont changés)."""
    with Session(engine) as session:
        note = session.get(Note, note_id)
        if not note or note.user_id != _USER_ID:
            return json.dumps({"error": "not found"})
        if title is not None:
            note.title = title
        if content is not None:
            note.content = content
        if color is not None:
            note.color = color
        if pinned is not None:
            note.pinned = pinned
        if archived is not None:
            note.archived = archived
        if due_at is not None:
            note.due_at = datetime.fromisoformat(due_at) if due_at else None
        if icon is not None:
            note.icon = icon
        note.updated_at = utcnow()
        session.add(note)
        session.commit()
        return json.dumps({"id": note_id, "updated": True})


@mcp.tool()
def delete_note(note_id: int) -> str:
    """Met une note à la corbeille."""
    with Session(engine) as session:
        note = session.get(Note, note_id)
        if not note or note.user_id != _USER_ID:
            return json.dumps({"error": "not found"})
        note.trashed_at = utcnow()
        note.updated_at = utcnow()
        session.add(note)
        session.commit()
        return json.dumps({"id": note_id, "trashed": True})


@mcp.tool()
def restore_note(note_id: int) -> str:
    """Restaure une note de la corbeille."""
    with Session(engine) as session:
        note = session.get(Note, note_id)
        if not note or note.user_id != _USER_ID:
            return json.dumps({"error": "not found"})
        note.trashed_at = None
        note.updated_at = utcnow()
        session.add(note)
        session.commit()
        return json.dumps({"id": note_id, "restored": True})


@mcp.tool()
def update_item(
    note_id: int,
    item_id: int,
    checked: Optional[bool] = None,
    text: Optional[str] = None,
) -> str:
    """Coche/décoche ou modifie le texte d'un item."""
    with Session(engine) as session:
        item = session.get(NoteItem, item_id)
        if not item or item.note_id != note_id:
            return json.dumps({"error": "not found"})
        note = session.get(Note, note_id)
        if not note or note.user_id != _USER_ID:
            return json.dumps({"error": "forbidden"})
        if checked is not None:
            item.checked = checked
            item.checked_at = utcnow() if checked else None
        if text is not None:
            item.text = text
        session.add(item)
        note.updated_at = utcnow()
        session.add(note)
        session.commit()
        return json.dumps({"item_id": item_id, "updated": True})


@mcp.tool()
def delete_item(note_id: int, item_id: int) -> str:
    """Supprime un item d'une note."""
    with Session(engine) as session:
        item = session.get(NoteItem, item_id)
        if not item or item.note_id != note_id:
            return json.dumps({"error": "not found"})
        note = session.get(Note, note_id)
        if not note or note.user_id != _USER_ID:
            return json.dumps({"error": "forbidden"})
        note.items.remove(item)
        note.updated_at = utcnow()
        session.add(note)
        session.commit()
        return json.dumps({"item_id": item_id, "deleted": True})


@mcp.tool()
def list_tasks(recent_done_days: int = 7) -> str:
    """Liste tâches datées (notes + items avec due_at, hors corbeille/archivées)."""
    with Session(engine) as session:
        tasks = []
        for n in session.exec(
            select(Note).where(
                Note.user_id == _USER_ID,
                Note.due_at.isnot(None),
                Note.trashed_at.is_(None),
                Note.archived == False,
            )
        ).all():
            tasks.append({
                "kind": "note",
                "id": n.id,
                "note_id": n.id,
                "title": n.title,
                "due_at": _dt(n.due_at),
                "done": n.done,
                "color": n.color,
                "icon": n.icon,
                "recur": n.recur,
            })
        for it in session.exec(
            select(NoteItem)
            .join(Note, NoteItem.note_id == Note.id)
            .where(
                Note.user_id == _USER_ID,
                NoteItem.due_at.isnot(None),
                NoteItem.trashed_at.is_(None),
                NoteItem.archived == False,
                Note.trashed_at.is_(None),
            )
        ).all():
            note = session.get(Note, it.note_id)
            tasks.append({
                "kind": "item",
                "id": it.id,
                "note_id": it.note_id,
                "note_title": note.title if note else "",
                "text": it.text,
                "due_at": _dt(it.due_at),
                "done": it.checked,
                "recur": it.recur,
            })
        return json.dumps(tasks, ensure_ascii=False)


@mcp.tool()
def set_task_done(kind: str, obj_id: int, done: bool) -> str:
    """Coche/décoche une tâche. kind='note'|'item'."""
    with Session(engine) as session:
        if kind == "note":
            note = session.get(Note, obj_id)
            if not note or note.user_id != _USER_ID:
                return json.dumps({"error": "not found"})
            note.done = done
            note.done_at = utcnow() if done else None
            note.updated_at = utcnow()
            session.add(note)
            session.commit()
            return json.dumps({"kind": "note", "id": obj_id, "done": done})
        if kind == "item":
            item = session.get(NoteItem, obj_id)
            if not item:
                return json.dumps({"error": "not found"})
            note = session.get(Note, item.note_id)
            if not note or note.user_id != _USER_ID:
                return json.dumps({"error": "forbidden"})
            item.checked = done
            item.checked_at = utcnow() if done else None
            session.add(item)
            note.updated_at = utcnow()
            session.add(note)
            session.commit()
            return json.dumps({"kind": "item", "id": obj_id, "done": done})
        return json.dumps({"error": "kind doit être 'note' ou 'item'"})


@mcp.tool()
def list_labels() -> str:
    """Liste les labels de l'utilisateur."""
    with Session(engine) as session:
        labels = session.exec(
            select(Label).where(Label.user_id == _USER_ID).order_by(Label.position.desc())
        ).all()
        return json.dumps(
            [{"id": lb.id, "name": lb.name, "color": lb.color} for lb in labels],
            ensure_ascii=False,
        )


# ─── app ASGI montable ────────────────────────────────────────────────────────

def create_mcp_app():
    """Retourne l'ASGI app MCP protégée par NOTASK_MCP_KEY."""
    inner = mcp.streamable_http_app()

    async def auth_wrapper(scope, receive, send):
        if scope["type"] == "http":
            headers = {k.lower(): v for k, v in scope.get("headers", [])}
            auth = headers.get(b"authorization", b"").decode()
            key = os.getenv("NOTASK_MCP_KEY", "")
            if not key or auth != f"Bearer {key}":
                from starlette.responses import Response as SR
                await SR("Unauthorized", status_code=401)(scope, receive, send)
                return
        await inner(scope, receive, send)

    return auth_wrapper
