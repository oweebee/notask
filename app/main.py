from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session, select

from app.db import get_session, init_db
from app.models import (
    Note,
    NoteCreate,
    NoteUpdate,
    Task,
    TaskCreate,
    TaskUpdate,
    utcnow,
)

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="notask",
    description="Gestion de tâches et de notes — API REST + UI web.",
    version="0.1.0",
    lifespan=lifespan,
)

# Ouvert pour permettre un futur client APK / mobile.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["system"])
def health():
    return {"status": "ok"}


# ---------------- Tasks ----------------

@app.get("/api/tasks", response_model=List[Task], tags=["tasks"])
def list_tasks(
    done: Optional[bool] = None,
    q: Optional[str] = Query(default=None, description="Recherche dans le titre"),
    session: Session = Depends(get_session),
):
    stmt = select(Task)
    if done is not None:
        stmt = stmt.where(Task.done == done)
    if q:
        stmt = stmt.where(Task.title.contains(q))
    return session.exec(stmt.order_by(Task.done, Task.priority.desc(), Task.id.desc())).all()


@app.post("/api/tasks", response_model=Task, status_code=201, tags=["tasks"])
def create_task(payload: TaskCreate, session: Session = Depends(get_session)):
    task = Task.model_validate(payload)
    session.add(task)
    session.commit()
    session.refresh(task)
    return task


@app.get("/api/tasks/{task_id}", response_model=Task, tags=["tasks"])
def get_task(task_id: int, session: Session = Depends(get_session)):
    task = session.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Tâche introuvable")
    return task


@app.patch("/api/tasks/{task_id}", response_model=Task, tags=["tasks"])
def update_task(task_id: int, payload: TaskUpdate, session: Session = Depends(get_session)):
    task = session.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Tâche introuvable")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(task, key, value)
    task.updated_at = utcnow()
    session.add(task)
    session.commit()
    session.refresh(task)
    return task


@app.delete("/api/tasks/{task_id}", status_code=204, tags=["tasks"])
def delete_task(task_id: int, session: Session = Depends(get_session)):
    task = session.get(Task, task_id)
    if not task:
        raise HTTPException(404, "Tâche introuvable")
    session.delete(task)
    session.commit()


# ---------------- Notes ----------------

@app.get("/api/notes", response_model=List[Note], tags=["notes"])
def list_notes(
    q: Optional[str] = Query(default=None, description="Recherche titre/contenu"),
    session: Session = Depends(get_session),
):
    stmt = select(Note)
    if q:
        stmt = stmt.where(Note.title.contains(q) | Note.content.contains(q))
    return session.exec(stmt.order_by(Note.updated_at.desc())).all()


@app.post("/api/notes", response_model=Note, status_code=201, tags=["notes"])
def create_note(payload: NoteCreate, session: Session = Depends(get_session)):
    note = Note.model_validate(payload)
    session.add(note)
    session.commit()
    session.refresh(note)
    return note


@app.get("/api/notes/{note_id}", response_model=Note, tags=["notes"])
def get_note(note_id: int, session: Session = Depends(get_session)):
    note = session.get(Note, note_id)
    if not note:
        raise HTTPException(404, "Note introuvable")
    return note


@app.patch("/api/notes/{note_id}", response_model=Note, tags=["notes"])
def update_note(note_id: int, payload: NoteUpdate, session: Session = Depends(get_session)):
    note = session.get(Note, note_id)
    if not note:
        raise HTTPException(404, "Note introuvable")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(note, key, value)
    note.updated_at = utcnow()
    session.add(note)
    session.commit()
    session.refresh(note)
    return note


@app.delete("/api/notes/{note_id}", status_code=204, tags=["notes"])
def delete_note(note_id: int, session: Session = Depends(get_session)):
    note = session.get(Note, note_id)
    if not note:
        raise HTTPException(404, "Note introuvable")
    session.delete(note)
    session.commit()


# ---------------- UI ----------------

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")
