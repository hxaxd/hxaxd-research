from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

import pytest

from app.core.database import SCHEMA_PATH
from app.utils.snapshots.backup import SnapshotWriter
from app.utils.snapshots.errors import SnapshotError
from app.utils.snapshots.paths import payload_relative_path
from app.utils.snapshots.restore import SnapshotRestorer
from tests.sample_data import PDF, create_paper_with_original


def test_exact_snapshot_round_trip(client, app_settings, tmp_path):
    paper = create_paper_with_original(client)
    archive = tmp_path / "today.researchpack"

    written = SnapshotWriter(
        app_settings.data_dir,
        app_settings.database_path,
        SCHEMA_PATH,
    ).write(archive)
    restored_dir = tmp_path / "restored"
    restored = SnapshotRestorer(SCHEMA_PATH).restore(archive, restored_dir)

    assert written.file_count == 2
    assert restored.file_count == 2
    assert restored.recovery_dir is None
    with sqlite3.connect(restored_dir / "research.sqlite3") as connection:
        assert connection.execute("SELECT COUNT(*) FROM papers").fetchone()[0] == 1
    assert (restored_dir / "artifacts" / paper["id"] / "original.pdf").read_bytes() == PDF


def test_restore_refuses_another_schema(client, app_settings, tmp_path):
    create_paper_with_original(client)
    archive = tmp_path / "today.researchpack"
    SnapshotWriter(
        app_settings.data_dir,
        app_settings.database_path,
        SCHEMA_PATH,
    ).write(archive)
    other_schema = tmp_path / "schema.sql"
    other_schema.write_text("-- a different exact version", encoding="utf-8")

    with pytest.raises(SnapshotError, match="数据库结构与当前程序不一致"):
        SnapshotRestorer(other_schema).restore(archive, tmp_path / "restored")


def test_restore_requires_explicit_replace(client, app_settings, tmp_path):
    create_paper_with_original(client)
    archive = tmp_path / "today.researchpack"
    SnapshotWriter(
        app_settings.data_dir,
        app_settings.database_path,
        SCHEMA_PATH,
    ).write(archive)
    target = tmp_path / "occupied"
    target.mkdir()
    (target / "keep.txt").write_text("keep", encoding="utf-8")

    with pytest.raises(SnapshotError, match="必须显式使用 --replace"):
        SnapshotRestorer(SCHEMA_PATH).restore(archive, target)


def test_backup_refuses_active_translation(client, app_settings, tmp_path):
    paper = create_paper_with_original(client)
    with sqlite3.connect(app_settings.database_path) as connection:
        connection.execute(
            """
            INSERT INTO jobs(
                id, paper_id, job_type, status, progress, message, created_at
            ) VALUES (?, ?, 'translate', 'running', 10, 'running', ?)
            """,
            ("active-job", paper["id"], datetime.now(UTC).isoformat()),
        )

    with pytest.raises(SnapshotError, match="尚未结束的翻译任务"):
        SnapshotWriter(
            app_settings.data_dir,
            app_settings.database_path,
            SCHEMA_PATH,
        ).write(tmp_path / "today.researchpack")


@pytest.mark.parametrize("path", ["research.sqlite3", "../payload/file", "/payload/file"])
def test_payload_paths_cannot_escape_archive(path):
    with pytest.raises(SnapshotError):
        payload_relative_path(path)
