from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path

from app.platform.activation import (
    FaultInjector,
    activate_v3_database,
    default_activation_journal,
)

from .database import V4_MIGRATION_PATH, DatabaseKind, V3Database, inspect_database

_V3_BASELINE_CHECKSUMS = frozenset(
    {
        # Git-normalized LF and Windows CRLF forms of the immutable v3 baseline.
        "102177290579b2a9ce83d5e12d8d1c5facc2e4c6d049e03bd92043bf0474ccbc",
        "49ce2c5530886bbc187e70001e1eb4534a26cc2c77a22b6f466772cd426ef266",
    }
)
_COUNT_TABLES = (
    "projects",
    "source_records",
    "works",
    "bibliographic_items",
    "item_creators",
    "item_identifiers",
    "project_works",
    "blobs",
    "blob_objects",
    "attachments",
    "jobs",
    "audit_events",
)


class V3MigrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class V3MigrationReport:
    source_database: Path
    active_database: Path
    backup_database: Path | None
    preserved_counts: dict[str, int]
    attachment_records_verified: int


def _read_only(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def _verify_v3_source(connection: sqlite3.Connection) -> None:
    migration = connection.execute(
        "SELECT name, checksum FROM schema_migrations WHERE version = 3"
    ).fetchone()
    if (
        migration is None
        or migration["name"] != "v3_baseline"
        or migration["checksum"] not in _V3_BASELINE_CHECKSUMS
    ):
        raise V3MigrationError("v3 database does not contain a verifiable baseline record")
    integrity = connection.execute("PRAGMA integrity_check").fetchone()
    if integrity is None or integrity[0] != "ok":
        raise V3MigrationError("v3 database integrity check failed")
    if connection.execute("PRAGMA foreign_key_check").fetchall():
        raise V3MigrationError("v3 database contains foreign key violations")


def _counts(connection: sqlite3.Connection) -> dict[str, int]:
    return {
        table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        for table in _COUNT_TABLES
    }


def _attachment_records(connection: sqlite3.Connection) -> list[tuple[object, ...]]:
    return [
        tuple(row)
        for row in connection.execute(
            """
            SELECT a.id, a.item_id, a.blob_id, a.filename,
                   b.sha256, b.size, o.id, o.storage_backend, o.storage_key, o.state
            FROM attachments a
            JOIN blobs b ON b.id = a.blob_id
            JOIN blob_objects o ON o.blob_id = b.id
            ORDER BY a.id, o.id
            """
        ).fetchall()
    ]


def build_v4_shadow(source_database: Path, target_database: Path) -> V3MigrationReport:
    """Copy a v3 database, upgrade the copy, and validate all preserved records."""

    source_database = source_database.resolve()
    target_database = target_database.resolve()
    if inspect_database(source_database).kind is not DatabaseKind.LEGACY_V3:
        raise V3MigrationError("source database is not a v3 research workspace")
    if target_database.exists():
        raise V3MigrationError("target database already exists")

    source = _read_only(source_database)
    try:
        _verify_v3_source(source)
        expected_counts = _counts(source)
        expected_attachments = _attachment_records(source)
        target_database.parent.mkdir(parents=True, exist_ok=True)
        target = sqlite3.connect(target_database, timeout=30)
        try:
            source.backup(target)
            target.execute("PRAGMA foreign_keys=ON")
            target.executescript("BEGIN IMMEDIATE;\n" + V4_MIGRATION_PATH.read_text("utf-8"))
            target.execute(
                """
                INSERT INTO schema_migrations(version, name, checksum, applied_at)
                VALUES(4, 'v4_from_v3', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                """,
                (V3Database.v4_migration_checksum(),),
            )
            target.commit()
        except Exception:
            target.rollback()
            raise
        finally:
            target.close()

        database = V3Database(target_database)
        database.verify()
        with database.read() as migrated:
            actual_counts = _counts(migrated)
            actual_attachments = _attachment_records(migrated)
            revision_count = int(
                migrated.execute("SELECT COUNT(*) FROM item_revisions").fetchone()[0]
            )
        if actual_counts != expected_counts:
            raise V3MigrationError(
                f"v3 migration count mismatch: expected {expected_counts}, got {actual_counts}"
            )
        if actual_attachments != expected_attachments:
            raise V3MigrationError("attachment identities or hashes changed during v3 migration")
        if revision_count != expected_counts["bibliographic_items"]:
            raise V3MigrationError("initial bibliographic revision history was not preserved")
    except Exception:
        target_database.unlink(missing_ok=True)
        raise
    finally:
        source.close()

    return V3MigrationReport(
        source_database=source_database,
        active_database=target_database,
        backup_database=None,
        preserved_counts=expected_counts,
        attachment_records_verified=len(expected_attachments),
    )


def migrate_v3_database(
    database_path: Path,
    *,
    activation_journal: Path | None = None,
    fault_injector: FaultInjector | None = None,
) -> V3MigrationReport:
    """Upgrade v3 through a verified shadow copy and atomic activation."""

    database_path = database_path.resolve()
    if inspect_database(database_path).kind is not DatabaseKind.LEGACY_V3:
        raise V3MigrationError("active database is not a v3 research workspace")
    shadow = database_path.with_name(f".{database_path.name}.v4-migrating-{uuid.uuid4().hex}")
    report = build_v4_shadow(database_path, shadow)
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    backup = database_path.with_name(f"{database_path.name}.v3-{timestamp}.bak")
    if backup.exists():
        shadow.unlink(missing_ok=True)
        raise V3MigrationError(f"backup database already exists: {backup}")

    activate_v3_database(
        database_path,
        shadow,
        backup,
        journal_path=(
            activation_journal
            if activation_journal is not None
            else default_activation_journal(database_path.parent)
        ),
        fault_injector=fault_injector,
    )
    return replace(report, active_database=database_path, backup_database=backup)
