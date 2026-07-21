from __future__ import annotations

import hashlib
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

BASELINE_PATH = Path(__file__).with_name("baseline.sql")
V3_SCHEMA_VERSION = 3


class DatabaseKind(StrEnum):
    MISSING = "missing"
    EMPTY = "empty"
    LEGACY_V1 = "legacy_v1"
    LEGACY_V2 = "legacy_v2"
    V3 = "v3"
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
            if version == V3_SCHEMA_VERSION and "bibliographic_items" in tables:
                return DatabaseState(DatabaseKind.V3, version)
            if "papers" in tables:
                columns = {
                    str(row[1])
                    for row in connection.execute("PRAGMA table_info(papers)").fetchall()
                }
                if "identity_key" in columns and "project_papers" in tables:
                    return DatabaseState(DatabaseKind.LEGACY_V2, version or 2)
                if "project_id" in columns:
                    return DatabaseState(DatabaseKind.LEGACY_V1, version or 1)
            return DatabaseState(DatabaseKind.UNKNOWN, version)
        finally:
            connection.close()
    except sqlite3.DatabaseError:
        return DatabaseState(DatabaseKind.UNKNOWN, None)


class V3Database:
    def __init__(self, path: Path):
        self.path = path.resolve()

    @staticmethod
    def baseline_checksum() -> str:
        return hashlib.sha256(BASELINE_PATH.read_bytes()).hexdigest()

    def initialize(self) -> None:
        state = inspect_database(self.path)
        if state.kind in {DatabaseKind.MISSING, DatabaseKind.EMPTY}:
            self._create_fresh()
            return
        if state.kind is not DatabaseKind.V3:
            raise RuntimeError(
                f"database is {state.kind.value}; use the explicit legacy importer"
            )
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
                VALUES(3, 'v3_baseline', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
        finally:
            connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def verify(self) -> None:
        state = inspect_database(self.path)
        if state.kind is not DatabaseKind.V3:
            raise RuntimeError("database does not contain the v3 baseline")
        with self.read() as connection:
            migration = connection.execute(
                "SELECT checksum FROM schema_migrations WHERE version = 3"
            ).fetchone()
            if migration is None or migration["checksum"] != self.baseline_checksum():
                raise RuntimeError("v3 baseline checksum does not match the applied schema")
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
