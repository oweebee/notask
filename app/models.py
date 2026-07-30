from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import JSON, Column
from sqlmodel import Field, Relationship, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ============================== Utilisateurs ==============================

class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True, min_length=2, max_length=50)
    password_hash: str
    is_admin: bool = False
    is_active: bool = True
    must_change_password: bool = False
    created_at: datetime = Field(default_factory=utcnow)


class UserPublic(SQLModel):
    id: int
    username: str
    is_admin: bool
    is_active: bool
    must_change_password: bool
    created_at: datetime


class UserCreate(SQLModel):
    username: str = Field(min_length=2, max_length=50)
    password: str = Field(min_length=8, max_length=200)
    is_admin: bool = False


class UserUpdate(SQLModel):
    password: Optional[str] = Field(default=None, min_length=8, max_length=200)
    is_admin: Optional[bool] = None
    is_active: Optional[bool] = None


class PasswordChange(SQLModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


class LoginRequest(SQLModel):
    username: str
    password: str


class Token(SQLModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


# =============================== Réglages ===============================

class UserSettings(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True, unique=True)
    data: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    updated_at: datetime = Field(default_factory=utcnow)


# ================================= Notes =================================
# La note est le seul objet que l'utilisateur crée.
#
# Une note porte éventuellement une échéance (`due_at`). Dans ce cas elle
# devient une tâche : elle apparaît dans la vue Tâches et devient cochable.
# Sans échéance, c'est une note ordinaire, non cochable.
#
# Chaque case à cocher d'une note peut elle aussi porter sa propre échéance.
# La ligne devient alors une tâche à part entière, sans changer d'apparence
# à l'intérieur de la note.

class NoteBase(SQLModel):
    title: str = Field(default="", max_length=300)
    content: str = ""
    color: str = Field(default="default", max_length=20)
    pinned: bool = False
    archived: bool = False
    is_checklist: bool = False
    # Échéance de la note entière. Non nulle => c'est une tâche.
    due_at: Optional[datetime] = None


class Note(NoteBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    done: bool = False
    done_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    items: List["NoteItem"] = Relationship(
        back_populates="note",
        sa_relationship_kwargs={"cascade": "all, delete-orphan", "order_by": "NoteItem.position"},
    )


class NoteItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    note_id: int = Field(foreign_key="note.id", index=True)
    text: str = Field(default="", max_length=500)
    checked: bool = False
    position: int = 0
    # Échéance propre à la ligne. Non nulle => la ligne est une tâche.
    due_at: Optional[datetime] = None

    note: Optional[Note] = Relationship(back_populates="items")


class NoteItemIn(SQLModel):
    id: Optional[int] = None
    text: str = ""
    checked: bool = False
    due_at: Optional[datetime] = None


class NoteItemUpdate(SQLModel):
    text: Optional[str] = None
    checked: Optional[bool] = None
    due_at: Optional[datetime] = None


class NoteItemOut(SQLModel):
    id: int
    text: str
    checked: bool
    position: int
    due_at: Optional[datetime] = None


class NoteCreate(NoteBase):
    items: List[NoteItemIn] = []


class NoteUpdate(SQLModel):
    title: Optional[str] = None
    content: Optional[str] = None
    color: Optional[str] = None
    pinned: Optional[bool] = None
    archived: Optional[bool] = None
    is_checklist: Optional[bool] = None
    due_at: Optional[datetime] = None
    done: Optional[bool] = None
    items: Optional[List[NoteItemIn]] = None


class NoteOut(NoteBase):
    id: int
    done: bool
    done_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    items: List[NoteItemOut] = []


# ================================ Tâches ================================
# Aucune table : une tâche est une vue sur une note datée ou sur une ligne
# à cocher datée. Rien ne se crée ici, tout naît d'une note.

class TaskOut(SQLModel):
    kind: str            # "note" ou "item"
    id: int              # identifiant de la note ou de la ligne
    note_id: int         # note d'origine, toujours renseignée
    note_title: str      # pour situer une ligne dans sa note
    text: str            # libellé affiché
    due_at: datetime
    done: bool
    color: str
    bucket: str          # "late" | "today" | "upcoming" | "done"


class TaskDone(SQLModel):
    done: bool
