"""Tâches — équivalent Google Tasks : listes, échéance, détails, sous-tâches, étoile."""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user
from app.models import (
    Task,
    TaskCreate,
    TaskList,
    TaskListCreate,
    TaskListOut,
    TaskListUpdate,
    TaskOut,
    TaskUpdate,
    User,
    utcnow,
)

router = APIRouter(prefix="/api", tags=["tasks"])


def _owned_list(list_id: int, user: User, session: Session) -> TaskList:
    tl = session.get(TaskList, list_id)
    if tl is None or tl.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Liste introuvable")
    return tl


def _owned_task(task_id: int, user: User, session: Session) -> Task:
    task = session.get(Task, task_id)
    if task is None or task.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tâche introuvable")
    return task


# ============================== Listes ==============================

@router.get("/lists", response_model=List[TaskListOut])
def list_lists(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    lists = session.exec(
        select(TaskList).where(TaskList.user_id == user.id).order_by(TaskList.position, TaskList.id)
    ).all()
    # Tout utilisateur dispose d'au moins une liste, comme dans Google Tasks.
    if not lists:
        default = TaskList(user_id=user.id, title="Mes tâches", position=0)
        session.add(default)
        session.commit()
        session.refresh(default)
        lists = [default]
    return lists


@router.post("/lists", response_model=TaskListOut, status_code=status.HTTP_201_CREATED)
def create_list(
    payload: TaskListCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    count = len(session.exec(select(TaskList.id).where(TaskList.user_id == user.id)).all())
    tl = TaskList(user_id=user.id, title=payload.title.strip(), position=count)
    session.add(tl)
    session.commit()
    session.refresh(tl)
    return tl


@router.patch("/lists/{list_id}", response_model=TaskListOut)
def update_list(
    list_id: int,
    payload: TaskListUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tl = _owned_list(list_id, user, session)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(tl, key, value)
    session.add(tl)
    session.commit()
    session.refresh(tl)
    return tl


@router.delete("/lists/{list_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_list(
    list_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tl = _owned_list(list_id, user, session)
    remaining = session.exec(
        select(TaskList).where(TaskList.user_id == user.id, TaskList.id != list_id)
    ).first()
    if remaining is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Impossible de supprimer la dernière liste")

    for task in session.exec(select(Task).where(Task.list_id == list_id)).all():
        session.delete(task)
    session.delete(tl)
    session.commit()


# ============================== Tâches ==============================

@router.get("/lists/{list_id}/tasks", response_model=List[TaskOut])
def list_tasks(
    list_id: int,
    include_completed: bool = Query(default=True),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _owned_list(list_id, user, session)
    stmt = select(Task).where(Task.list_id == list_id, Task.user_id == user.id)
    if not include_completed:
        stmt = stmt.where(Task.completed == False)  # noqa: E712
    return session.exec(stmt.order_by(Task.completed, Task.position, Task.id)).all()


@router.post("/lists/{list_id}/tasks", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
def create_task(
    list_id: int,
    payload: TaskCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _owned_list(list_id, user, session)

    if payload.parent_id is not None:
        parent = _owned_task(payload.parent_id, user, session)
        if parent.parent_id is not None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Un seul niveau de sous-tâches")
        if parent.list_id != list_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "La tâche parente est dans une autre liste")

    count = len(session.exec(select(Task.id).where(Task.list_id == list_id)).all())
    task = Task(**payload.model_dump(), user_id=user.id, list_id=list_id, position=count)
    session.add(task)
    session.commit()
    session.refresh(task)
    return task


@router.get("/tasks/{task_id}", response_model=TaskOut)
def get_task(
    task_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return _owned_task(task_id, user, session)


@router.patch("/tasks/{task_id}", response_model=TaskOut)
def update_task(
    task_id: int,
    payload: TaskUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    task = _owned_task(task_id, user, session)
    data = payload.model_dump(exclude_unset=True)

    if "list_id" in data and data["list_id"] is not None:
        _owned_list(data["list_id"], user, session)
    if "parent_id" in data and data["parent_id"] is not None:
        if data["parent_id"] == task.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Une tâche ne peut pas être sa propre parente")
        parent = _owned_task(data["parent_id"], user, session)
        if parent.parent_id is not None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Un seul niveau de sous-tâches")

    if "completed" in data and data["completed"] != task.completed:
        task.completed_at = utcnow() if data["completed"] else None
        # Cocher une tâche coche ses sous-tâches, comme dans Google Tasks.
        if data["completed"]:
            for child in session.exec(select(Task).where(Task.parent_id == task.id)).all():
                child.completed = True
                child.completed_at = task.completed_at
                session.add(child)

    for key, value in data.items():
        setattr(task, key, value)

    task.updated_at = utcnow()
    session.add(task)
    session.commit()
    session.refresh(task)
    return task


@router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(
    task_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    task = _owned_task(task_id, user, session)
    for child in session.exec(select(Task).where(Task.parent_id == task.id)).all():
        session.delete(child)
    session.delete(task)
    session.commit()


@router.post("/lists/{list_id}/clear-completed", status_code=status.HTTP_204_NO_CONTENT)
def clear_completed(
    list_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Supprime les tâches terminées de la liste (bouton « Effacer terminées » de Google Tasks)."""
    _owned_list(list_id, user, session)
    for task in session.exec(
        select(Task).where(Task.list_id == list_id, Task.user_id == user.id, Task.completed == True)  # noqa: E712
    ).all():
        session.delete(task)
    session.commit()
