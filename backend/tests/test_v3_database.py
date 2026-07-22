from __future__ import annotations

import sqlite3

import pytest

from app.jobs import JobCreate, JobStatus, SqliteJobRepository
from app.platform.db import DatabaseKind, WorkspaceDatabase, inspect_database

REQUIRED_TABLES = {
    "works",
    "bibliographic_items",
    "item_creators",
    "item_identifiers",
    "item_links",
    "source_records",
    "project_works",
    "project_work_roles",
    "project_work_notes",
    "candidates",
    "blobs",
    "blob_objects",
    "attachments",
    "attachment_preferences",
    "attachment_relations",
    "jobs",
    "job_attempts",
    "job_events",
    "job_attachments",
    "audit_events",
    "external_bindings",
    "sync_runs",
    "sync_conflicts",
    "zotero_transfer_previews",
    "zotero_transfer_resolutions",
    "zotero_transfer_receipts",
    "agent_runs",
    "agent_events",
    "approvals",
    "change_sets",
    "change_items",
    "item_revisions",
    "documents",
    "document_blocks",
    "block_translations",
    "document_glossary_entries",
    "annotations",
    "annotation_tags",
    "reading_states",
    "user_preferences",
    "device_pairings",
    "device_sessions",
}


def test_fresh_database_uses_only_the_v4_baseline(tmp_path):
    path = tmp_path / "research.sqlite3"
    database = WorkspaceDatabase(path)
    database.initialize()

    assert database.schema_version() == 4
    assert inspect_database(path).kind is DatabaseKind.V4
    with database.read() as connection:
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        migration = connection.execute("SELECT * FROM schema_migrations").fetchone()
    assert tables >= REQUIRED_TABLES
    assert migration["version"] == 4
    assert migration["name"] == "v4_baseline"
    assert migration["checksum"] == database.baseline_checksum()
    assert "papers" not in tables
    assert "resources" not in tables


def test_applied_baseline_is_immutable(tmp_path):
    path = tmp_path / "research.sqlite3"
    database = WorkspaceDatabase(path)
    database.initialize()
    with sqlite3.connect(path) as connection:
        connection.execute("UPDATE schema_migrations SET checksum='changed' WHERE version=4")

    with pytest.raises(RuntimeError, match="checksum"):
        database.verify()


def test_already_migrated_v4_database_keeps_its_historical_checksum_contract(tmp_path):
    path = tmp_path / "research.sqlite3"
    database = WorkspaceDatabase(path)
    database.initialize()
    with sqlite3.connect(path) as connection:
        connection.execute(
            "UPDATE schema_migrations SET name='v4_from_v3', checksum=? WHERE version=4",
            (database.v4_migration_checksum(),),
        )

    database.verify()


def test_non_current_database_is_rejected_without_modification(tmp_path):
    path = tmp_path / "research.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE papers(id TEXT PRIMARY KEY)")
        connection.execute("INSERT INTO papers VALUES('preserved')")

    with pytest.raises(RuntimeError, match="current v4"):
        WorkspaceDatabase(path).initialize()

    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT id FROM papers").fetchone()[0] == "preserved"


def test_durable_job_repository_uses_the_current_baseline_tables(tmp_path):
    path = tmp_path / "research.sqlite3"
    WorkspaceDatabase(path).initialize()
    repository = SqliteJobRepository(path)

    # This validates the schema contract but must not create a second jobs shape.
    repository.initialize_schema()
    job = repository.enqueue(JobCreate(kind="test.current", input={"value": 1}))
    claimed = repository.claim_next("current-worker")

    assert job.status is JobStatus.QUEUED
    assert claimed is not None
    assert claimed.job.id == job.id
    assert repository.list_events(job.id)[0].event_type == "job.queued"
