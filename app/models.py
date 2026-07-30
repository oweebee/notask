from datetime import date, datetime, timezone
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


# ============================== Réglages ==============================
# Boîte libre : le serveur conserve un objet JSON par utilisateur sans
# interpréter son contenu. Le web et un futur client Android y rangent ce
# qu'ils veulent (thème, tri, dernière liste ouverte…) sans modification
# du serveur.

class UserSettings(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True, unique=True)
    data: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    updated_at: datetime = Field(default_factory=utcnow)


# ================================= Notes =================================
# Équivalent Google Keep : couleur, épinglage, archive, cases à cocher.

class NoteBase(SQLModel):
    title: str = Field(default="", max_length=300)
    content: str = ""
    color: str = Field(default="default", max_length=20)
    pinned: bool = False
    archived: bool = False
    is_checklist: bool = False


class Note(NoteBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
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

    note: Optional[Note] = Relationship(back_populates="items")


class NoteItemIn(SQLModel):
    id: Optional[int] = None
    text: str = ""
    checked: bool = False


class NoteItemOut(SQLModel):
    id: int
    text: str
    checked: bool
    position: int


class NoteCreate(NoteBase):
    items: List[NoteItemIn] = []


class NoteUpdate(SQLModel):
    title: Optional[str] = None
    content: Optional[str] = None
    color: Optional[str] = None
    pinned: Optional[bool] = None
    archived: Optional[bool] = None
    is_checklist: Optional[bool] = None
    items: Optional[List[NoteItemIn]] = None


class NoteOut(NoteBase):
    id: int
    created_at: datetime
    updated_at: datetime
    items: List[NoteItemOut] = []


# ================================= Tâches =================================
# Équivalent Google Tasks : listes, échéance, détails, sous-tâches, étoile.

class TaskListBase(SQLModel):
    title: str = Field(min_length=1, max_length=100)
    position: int = 0


class TaskList(TaskListBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    created_at: datetime = Field(default_factory=utcnow)


class TaskListCreate(SQLModel):
    title: str = Field(min_length=1, max_length=100)


class TaskListUpdate(SQLModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=100)
    position: Optional[int] = None


class TaskListOut(TaskListBase):
    id: int
    created_at: datetime


class TaskBase(SQLModel):
    title: str = Field(min_length=1, max_length=300)
    details: str = ""
    due_date: Optional[date] = None
    completed: bool = False
    starred: bool = False
    position: int = 0


class Task(TaskBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    list_id: int = Field(foreign_key="tasklist.id", index=True)
    parent_id: Optional[int] = Field(default=None, foreign_key="task.id", index=True)
    completed_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class TaskCreate(SQLModel):
    title: str = Field(min_length=1, max_length=300)
    details: str = ""
    due_date: Optional[date] = None
    starred: bool = False
    parent_id: Optional[int] = None


class TaskUpdate(SQLModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=300)
    details: Optional[str] = None
    due_date: Optional[date] = None
    completed: Optional[bool] = None
    starred: Optional[bool] = None
    position: Optional[int] = None
    list_id: Optional[int] = None
    parent_id: Optional[int] = None


class TaskOut(TaskBase):
    id: int
    list_id: int
    parent_id: Optional[int] = None
    completed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
