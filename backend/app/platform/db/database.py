from __future__ import annotations

import hashlib
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from enum import StrEnum
from itertools import count
from pathlib import Path

BASELINE_PATH = Path(__file__).with_name("baseline.sql")
V4_MIGRATION_PATH = Path(__file__).with_name("v4_from_v3.sql")
CURRENT_SCHEMA_VERSION = 4


class DatabaseKind(StrEnum):
    MISSING = "missing"
    EMPTY = "empty"
    V4 = "v4"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class DatabaseState:
    kind: DatabaseKind
    schema_version: int | None


def _tables(connection: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
    }


def inspect_database(path: Path) -> DatabaseState:
    path = path.resolve()
    if not path.exists():
        return DatabaseState(DatabaseKind.MISSING, None)
    if not path.is_file():
        return DatabaseState(DatabaseKind.UNKNOWN, None)
    try:
        connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        try:
            tables = _tables(connection)
            if not tables:
                return DatabaseState(DatabaseKind.EMPTY, None)
            version: int | None = None
            if "schema_migrations" in tables:
                row = connection.execute(
                    "SELECT COALESCE(MAX(version), 0) FROM schema_migrations"
                ).fetchone()
                version = int(row[0])
            if version == CURRENT_SCHEMA_VERSION and "bibliographic_items" in tables:
                return DatabaseState(DatabaseKind.V4, version)
            return DatabaseState(DatabaseKind.UNKNOWN, version)
        finally:
            connection.close()
    except sqlite3.DatabaseError:
        return DatabaseState(DatabaseKind.UNKNOWN, None)


class WorkspaceDatabase:
    """Domain-oriented access to the single current workspace schema."""

    def __init__(self, path: Path):
        self.path = path.resolve()
        self._active_transaction: ContextVar[sqlite3.Connection | None] = ContextVar(
            f"research_transaction_{id(self)}",
            default=None,
        )
        self._savepoints = count(1)

    @staticmethod
    def baseline_checksum() -> str:
        return hashlib.sha256(BASELINE_PATH.read_bytes()).hexdigest()

    @staticmethod
    def v4_migration_checksum() -> str:
        return hashlib.sha256(V4_MIGRATION_PATH.read_bytes()).hexdigest()

    def initialize(self) -> None:
        state = inspect_database(self.path)
        if state.kind in {DatabaseKind.MISSING, DatabaseKind.EMPTY}:
            self._create_fresh()
            return
        if state.kind is not DatabaseKind.V4:
            raise RuntimeError("database is not an empty or current v4 workspace")
        self.verify()

    def _create_fresh(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=30)
        try:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.executescript("BEGIN IMMEDIATE;\n" + BASELINE_PATH.read_text("utf-8"))
            connection.execute(
                """
                INSERT INTO schema_migrations(version, name, checksum, applied_at)
                VALUES(4, 'v4_baseline', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                """,
                (self.baseline_checksum(),),
            )
            connection.commit()
        except Exception:
            connection.rollback()
            connection.close()
            self.path.unlink(missing_ok=True)
            raise
        finally:
            if connection:
                connection.close()
        self.verify()

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        active = self._active_transaction.get()
        if active is not None:
            yield active
            return
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
        finally:
            connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        active = self._active_transaction.get()
        if active is not None:
            savepoint = f"nested_{next(self._savepoints)}"
            active.execute(f"SAVEPOINT {savepoint}")
            try:
                yield active
                active.execute(f"RELEASE SAVEPOINT {savepoint}")
            except Exception:
                active.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                active.execute(f"RELEASE SAVEPOINT {savepoint}")
                raise
            return
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        token = self._active_transaction.set(connection)
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            self._active_transaction.reset(token)
            connection.close()

    def verify(self) -> None:
        state = inspect_database(self.path)
        if state.kind is not DatabaseKind.V4:
            raise RuntimeError("database does not contain the v4 schema")
        with self.read() as connection:
            migration = connection.execute(
                "SELECT name, checksum FROM schema_migrations WHERE version = 4"
            ).fetchone()
            expected_checksums = {
                "v4_baseline": self.baseline_checksum(),
                "v4_from_v3": self.v4_migration_checksum(),
            }
            if (
                migration is None
                or migration["name"] not in expected_checksums
                or migration["checksum"] != expected_checksums[migration["name"]]
            ):
                raise RuntimeError("v4 schema checksum does not match the applied migration")
            integrity = connection.execute("PRAGMA integrity_check").fetchone()
            if integrity is None or integrity[0] != "ok":
                raise RuntimeError("database integrity check failed")
            violations = connection.execute("PRAGMA foreign_key_check").fetchall()
            if violations:
                raise RuntimeError("database contains foreign key violations")

    def schema_version(self) -> int:
        with self.read() as connection:
            row = connection.execute(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations"
            ).fetchone()
        return int(row[0])
