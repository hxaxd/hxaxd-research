from __future__ import annotations

import importlib.util
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

MIGRATIONS_DIR = Path(__file__).with_name("migrations")


@dataclass(frozen=True)
class Migration:
    version: int
    path: Path


class MigrationRunner:
    def __init__(self, database_path: Path):
        self.database_path = database_path

    def run(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            self._ensure_history(connection)
            applied = {
                int(row[0]) for row in connection.execute("SELECT version FROM schema_migrations")
            }
            for migration in self._discover():
                if migration.version in applied:
                    continue
                self._apply(connection, migration)
        finally:
            connection.close()

    @staticmethod
    def _ensure_history(connection: sqlite3.Connection) -> None:
        has_legacy = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='papers'"
        ).fetchone()
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        if has_legacy:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(papers)").fetchall()}
            if "project_id" in columns:
                connection.execute(
                    "INSERT OR IGNORE INTO schema_migrations(version, name) VALUES(1, ?)",
                    ("001_initial.sql",),
                )
        connection.commit()

    @staticmethod
    def _discover() -> list[Migration]:
        migrations: list[Migration] = []
        for path in MIGRATIONS_DIR.iterdir():
            if path.suffix not in {".sql", ".py"} or not path.name[:3].isdigit():
                continue
            migrations.append(Migration(version=int(path.name[:3]), path=path))
        versions = [item.version for item in migrations]
        if len(versions) != len(set(versions)):
            raise RuntimeError("duplicate database migration version")
        return sorted(migrations, key=lambda item: item.version)

    @staticmethod
    def _apply(connection: sqlite3.Connection, migration: Migration) -> None:
        try:
            if migration.path.suffix == ".sql":
                connection.executescript(
                    "BEGIN IMMEDIATE;\n" + migration.path.read_text(encoding="utf-8")
                )
            else:
                module = MigrationRunner._load_module(migration.path)
                module.upgrade(connection)
            connection.execute(
                "INSERT INTO schema_migrations(version, name) VALUES(?, ?)",
                (migration.version, migration.path.name),
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise

    @staticmethod
    def _load_module(path: Path) -> ModuleType:
        spec = importlib.util.spec_from_file_location(f"migration_{path.stem}", path)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"cannot load migration: {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
