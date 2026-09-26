"""Project registry store tests: persistence, uniqueness, binding."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.projects.models import Project
from app.projects.store import ProjectStore, RegistrationConflictError


def make_project(tmp_path: Path, project_id: str = "a" * 32) -> Project:
    return Project(
        id=project_id,
        name="示例项目",
        directory=str(tmp_path / "projects" / project_id),
        workspace_id=None,
        created_at="2026-09-26T00:00:00Z",
        updated_at="2026-09-26T00:00:00Z",
    )


def insert(store: ProjectStore, project: Project, request_id: str) -> None:
    store.insert(
        project_id=project.id,
        name=project.name,
        directory=project.directory,
        request_id=request_id,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


def test_insert_and_find_roundtrip(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path / "registry.sqlite3")
    project = make_project(tmp_path)
    insert(store, project, "req-1")

    assert store.find_by_id(project.id) == project
    assert store.find_by_request_id("req-1") == project
    assert store.list_projects() == [project]


def test_rows_survive_reopening_the_store(tmp_path: Path) -> None:
    path = tmp_path / "registry.sqlite3"
    store = ProjectStore(path)
    project = make_project(tmp_path)
    insert(store, project, "req-1")

    reopened = ProjectStore(path)
    assert reopened.find_by_id(project.id) == project


def test_unique_request_id_and_directory(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path / "registry.sqlite3")
    insert(store, make_project(tmp_path), "req-1")

    with pytest.raises(RegistrationConflictError):
        insert(store, make_project(tmp_path, "b" * 32), "req-1")
    with pytest.raises(RegistrationConflictError):
        insert(store, make_project(tmp_path), "req-2")


def test_bind_workspace_is_idempotent_and_guards_changes(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path / "registry.sqlite3")
    project = make_project(tmp_path)
    insert(store, project, "req-1")

    assert store.bind_workspace(project.id, "c" * 8 + "-1", "2026-09-26T01:00:00Z")
    bound = store.find_by_id(project.id)
    assert bound is not None and bound.workspace_id == "c" * 8 + "-1"
    assert bound.updated_at == "2026-09-26T01:00:00Z"

    # Same id again: accepted, keeps working.
    assert store.bind_workspace(project.id, "c" * 8 + "-1", "2026-09-26T02:00:00Z")
    # A different workspace id is refused at the store level.
    assert not store.bind_workspace(project.id, "d" * 8 + "-2", "2026-09-26T03:00:00Z")
    assert store.find_by_id(project.id).workspace_id == "c" * 8 + "-1"

    assert not store.bind_workspace("missing", "e" * 8, "2026-09-26T00:00:00Z")
