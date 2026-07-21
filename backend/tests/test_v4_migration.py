from __future__ import annotations

import sqlite3

import pytest

from app.platform.activation import recover_pending_activation
from app.platform.db import DatabaseKind, V3Database, inspect_database
from app.platform.db.v4_migration import build_v4_shadow, migrate_v3_database

NOW = "2026-07-22T00:00:00Z"
V3_CHECKSUM = "102177290579b2a9ce83d5e12d8d1c5facc2e4c6d049e03bd92043bf0474ccbc"
V4_TABLES = (
    "annotation_tags",
    "annotations",
    "block_translations",
    "document_glossary_entries",
    "translation_batch_checkpoints",
    "document_blocks",
    "documents",
    "change_items",
    "item_revisions",
    "change_sets",
    "reading_states",
    "user_preferences",
    "device_sessions",
    "device_pairings",
)


class _SimulatedProcessCrash(BaseException):
    pass


def _create_v3_workspace(path) -> None:
    database = V3Database(path)
    database.initialize()
    with database.transaction() as connection:
        connection.execute(
            "INSERT INTO projects(id, name, created_at, updated_at) VALUES('p1', 'P', ?, ?)",
            (NOW, NOW),
        )
        connection.execute(
            "INSERT INTO works(id, created_at, updated_at) VALUES('w1', ?, ?)",
            (NOW, NOW),
        )
        connection.execute(
            """
            INSERT INTO bibliographic_items(
                id, work_id, item_type, title, is_preferred_for_work, created_at, updated_at
            ) VALUES('i1', 'w1', 'journalArticle', 'Preserved', 1, ?, ?)
            """,
            (NOW, NOW),
        )
        connection.execute(
            """
            INSERT INTO project_works(
                id, project_id, work_id, status, created_at, updated_at
            ) VALUES('pw1', 'p1', 'w1', 'discovered', ?, ?)
            """,
            (NOW, NOW),
        )
        connection.execute(
            """
            INSERT INTO blobs(id, sha256, size, media_type, created_at)
            VALUES('b1', ?, 3, 'application/pdf', ?)
            """,
            ("a" * 64, NOW),
        )
        connection.execute(
            """
            INSERT INTO blob_objects(
                id, blob_id, storage_backend, storage_key, is_primary, state, created_at
            ) VALUES('bo1', 'b1', 'local', 'library/a.pdf', 1, 'available', ?)
            """,
            (NOW,),
        )
        connection.execute(
            """
            INSERT INTO attachments(
                id, item_id, blob_id, attachment_type, format,
                language_mode, origin, filename, created_at
            ) VALUES(
                'a1', 'i1', 'b1', 'fulltext', 'pdf',
                'original', 'imported', 'a.pdf', ?
            )
            """,
            (NOW,),
        )

    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA foreign_keys=OFF")
        for table in V4_TABLES:
            connection.execute(f"DROP TABLE {table}")
        connection.execute("ALTER TABLE bibliographic_items DROP COLUMN revision")
        connection.execute("ALTER TABLE agent_runs DROP COLUMN target_type")
        connection.execute("ALTER TABLE agent_runs DROP COLUMN target_id")
        connection.execute("ALTER TABLE agent_runs DROP COLUMN reasoning_effort")
        connection.execute("DELETE FROM schema_migrations")
        connection.execute(
            """
            INSERT INTO schema_migrations(version, name, checksum, applied_at)
            VALUES(3, 'v3_baseline', ?, ?)
            """,
            (V3_CHECKSUM, NOW),
        )
        connection.commit()
    finally:
        connection.close()
    assert inspect_database(path).kind is DatabaseKind.LEGACY_V3


def test_v3_is_upgraded_only_in_a_validated_shadow_copy(tmp_path):
    source = tmp_path / "research.sqlite3"
    target = tmp_path / ".research.sqlite3.v4-migrating-test"
    _create_v3_workspace(source)

    report = build_v4_shadow(source, target)

    assert inspect_database(source).kind is DatabaseKind.LEGACY_V3
    assert inspect_database(target).kind is DatabaseKind.V4
    assert report.preserved_counts["bibliographic_items"] == 1
    assert report.attachment_records_verified == 1
    with V3Database(target).read() as connection:
        item = connection.execute(
            "SELECT title, revision FROM bibliographic_items WHERE id='i1'"
        ).fetchone()
        revision = connection.execute(
            "SELECT actor_id, changes_json FROM item_revisions WHERE item_id='i1'"
        ).fetchone()
    assert (item["title"], item["revision"]) == ("Preserved", 1)
    assert revision["actor_id"] == "v3-migrator"
    assert '"title":"Preserved"' in revision["changes_json"]


def test_v3_activation_is_replayed_after_process_crash(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    database_path = data_dir / "research.sqlite3"
    journal_path = tmp_path / ".runtime" / "workspace-activation.json"
    _create_v3_workspace(database_path)

    def crash(point: str) -> None:
        if point == "v3.after_source_moved":
            raise _SimulatedProcessCrash

    with pytest.raises(_SimulatedProcessCrash):
        migrate_v3_database(
            database_path,
            activation_journal=journal_path,
            fault_injector=crash,
        )

    assert not database_path.exists()
    assert journal_path.is_file()
    recovered = recover_pending_activation(
        journal_path,
        data_dir=data_dir,
        database_path=database_path,
    )

    assert recovered == "v3_migration:committed"
    assert inspect_database(database_path).kind is DatabaseKind.V4
    backups = list(data_dir.glob("research.sqlite3.v3-*.bak"))
    assert len(backups) == 1
    assert inspect_database(backups[0]).kind is DatabaseKind.LEGACY_V3
