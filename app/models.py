from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------- Tasks ----------

class TaskBase(SQLModel):
    title: str = Field(index=True, min_length=1, max_length=300)
    description: Optional[str] = None
    done: bool = False
    priority: int = Field(default=2, ge=0, le=3)  # 0=basse .. 3=urgente
    due_date: Optional[datetime] = None


class Task(TaskBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class TaskCreate(TaskBase):
    pass


class TaskUpdate(SQLModel):
    title: Optional[str] = None
    description: Optional[str] = None
    done: Optional[bool] = None
    priority: Optional[int] = Field(default=None, ge=0, le=3)
    due_date: Optional[datetime] = None


# ---------- Notes ----------

class NoteBase(SQLModel):
    title: str = Field(index=True, min_length=1, max_length=300)
    content: str = ""
    tags: Optional[str] = None  # tags séparés par des virgules


class Note(NoteBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class NoteCreate(NoteBase):
    pass


class NoteUpdate(SQLModel):
    title: Optional[str] = None
    content: Optional[str] = None
    tags: Optional[str] = None
