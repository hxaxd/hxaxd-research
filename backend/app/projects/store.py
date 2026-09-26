"""SQLite-backed project registry.

Single-user local store: WAL journaling for crash safety, one connection per
operation, schema created on first use. The registry records only project
identity, display name, managed directory, the bound DSH workspace id, and
the client request id that produced it. Chat history and files are NOT
stored here; DSH owns sessions and the filesystem owns the directory.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .models import Project

_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    directory TEXT NOT NULL UNIQUE,
    workspace_id TEXT UNIQUE,
    request_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

_COLUMNS = "id, name, directory, workspace_id, created_at, updated_at"


class RegistrationConflictError(RuntimeError):
    """A concurrent registration claimed the same unique key first."""


class ProjectStore:
    def __init__(self, path: Path) -> None:
        self._path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(_SCHEMA)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self._path, timeout=10.0)
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.row_factory = sqlite3.Row
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def find_by_request_id(self, request_id: str) -> Project | None:
        with self._connect() as connection:
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM projects WHERE request_id = ?",
                (request_id,),
            ).fetchone()
        return self._to_project(row)

    def find_by_id(self, project_id: str) -> Project | None:
        with self._connect() as connection:
            row = connection.execute(
                f"SELECT {_COLUMNS} FROM projects WHERE id = ?",
                (project_id,),
            ).fetchone()
        return self._to_project(row)

    def list_projects(self) -> list[Project]:
        with self._connect() as connection:
            rows = connection.execute(
                f"SELECT {_COLUMNS} FROM projects ORDER BY created_at DESC, id"
            ).fetchall()
        return [project for row in rows if (project := self._to_project(row))]

    def insert(
        self,
        *,
        project_id: str,
        name: str,
        directory: str,
        request_id: str,
        created_at: str,
        updated_at: str,
    ) -> None:
        """Insert one registration; unique violations raise
        `RegistrationConflictError` so the caller can re-read the winner."""
        with self._connect() as connection:
            try:
                connection.execute(
                    "INSERT INTO projects"
                    " (id, name, directory, workspace_id, request_id,"
                    "  created_at, updated_at)"
                    " VALUES (?, ?, ?, NULL, ?, ?, ?)",
                    (project_id, name, directory, request_id, created_at, updated_at),
                )
            except sqlite3.IntegrityError as error:
                raise RegistrationConflictError(str(error)) from error

    def bind_workspace(
        self, project_id: str, workspace_id: str, updated_at: str
    ) -> bool:
        """Attach the DSH workspace id to a project.

        Returns False when the project does not exist. Idempotent: binding
        the same workspace again is accepted; a different id over an
        existing binding is refused by the service layer.
        """
        with self._connect() as connection:
            cursor = connection.execute(
                "UPDATE projects SET workspace_id = ?, updated_at = ?"
                " WHERE id = ? AND (workspace_id IS NULL OR workspace_id = ?)",
                (workspace_id, updated_at, project_id, workspace_id),
            )
        return cursor.rowcount > 0

    @staticmethod
    def _to_project(row: sqlite3.Row | None) -> Project | None:
        if row is None:
            return None
        return Project(
            id=row["id"],
            name=row["name"],
            directory=row["directory"],
            workspace_id=row["workspace_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
