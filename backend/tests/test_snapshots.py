from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from app.core.database import SCHEMA_PATH
from app.core.migrations import MIGRATIONS_DIR, MigrationRunner
from app.utils.snapshots.backup import SnapshotWriter
from app.utils.snapshots.contract import DATABASE_ARCHIVE_PATH, MANIFEST_PATH
from app.utils.snapshots.errors import SnapshotError
from app.utils.snapshots.hashing import sha256_file
from app.utils.snapshots.paths import payload_relative_path
from app.utils.snapshots.restore import SnapshotRestorer
from tests.sample_data import PDF, create_paper_with_original


def test_v2_snapshot_round_trip(client, app_settings, tmp_path):
    paper = create_paper_with_original(client)
    archive = tmp_path / "today.researchpack"
    written = SnapshotWriter(app_settings.data_dir, app_settings.database_path, SCHEMA_PATH).write(
        archive
    )
    restored_dir = tmp_path / "restored"
    restored = SnapshotRestorer(SCHEMA_PATH).restore(archive, restored_dir)
    assert written.file_count == 2
    assert restored.file_count == 2
    with sqlite3.connect(restored_dir / "research.sqlite3") as connection:
        assert connection.execute("SELECT COUNT(*) FROM papers").fetchone()[0] == 1
        assert connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 2
        path = connection.execute("SELECT relative_path FROM resources").fetchone()[0]
    assert (restored_dir / path).read_bytes() == PDF
    assert paper["id"]


def test_v1_snapshot_is_restored_then_migrated(tmp_path):
    source = tmp_path / "legacy"
    source.mkdir()
    database = source / "research.sqlite3"
    _create_v1_database(database)
    artifact = source / "artifacts" / "paper-1" / "original.pdf"
    artifact.parent.mkdir(parents=True)
    artifact.write_bytes(PDF)
    with sqlite3.connect(database) as connection:
        connection.execute(
            """
            INSERT INTO artifacts(id, paper_id, kind, relative_path, sha256, size, created_at)
            VALUES('artifact-1', 'paper-1', 'original', ?, ?, ?, '2026-01-01T00:00:00Z')
            """,
            ("artifacts/paper-1/original.pdf", sha256_file(artifact), artifact.stat().st_size),
        )
    archive = tmp_path / "legacy.researchpack"
    _write_v1_snapshot(source, database, artifact, archive)
    restored = tmp_path / "restored"
    SnapshotRestorer(SCHEMA_PATH).restore(archive, restored)
    with sqlite3.connect(restored / "research.sqlite3") as connection:
        assert connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM project_papers").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM resources").fetchone()[0] == 1


def test_restore_requires_explicit_replace(client, app_settings, tmp_path):
    create_paper_with_original(client)
    archive = tmp_path / "today.researchpack"
    SnapshotWriter(app_settings.data_dir, app_settings.database_path, SCHEMA_PATH).write(archive)
    target = tmp_path / "occupied"
    target.mkdir()
    (target / "keep.txt").write_text("keep", encoding="utf-8")
    with pytest.raises(SnapshotError, match="必须显式使用 --replace"):
        SnapshotRestorer(SCHEMA_PATH).restore(archive, target)


@pytest.mark.parametrize("path", ["research.sqlite3", "../payload/file", "/payload/file"])
def test_payload_paths_cannot_escape_archive(path):
    with pytest.raises(SnapshotError):
        payload_relative_path(path)


def test_migration_upgrades_v1_database_and_preserves_counts(tmp_path):
    database = tmp_path / "research.sqlite3"
    _create_v1_database(database)
    MigrationRunner(database).run()
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM projects").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM papers").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM project_papers").fetchone()[0] == 1
        assert connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 2


def _create_v1_database(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.executescript((MIGRATIONS_DIR / "001_initial.sql").read_text(encoding="utf-8"))
        connection.execute(
            "INSERT INTO projects VALUES('project-1','Legacy','',? ,?)",
            ("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
        )
        connection.execute(
            """
            INSERT INTO papers VALUES(
                'paper-1','project-1','doi:10.48550/arxiv.2601.01234','included',
                'Legacy Paper','旧论文','["Ada Example et al."]','Legacy Org',2026,
                'arXiv preprint','方法','method','contribution','relevant','focus','relations',
                'https://arxiv.org/abs/2601.01234',NULL,NULL,
                '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'
            )
            """
        )


def _write_v1_snapshot(source: Path, database: Path, artifact: Path, archive: Path) -> None:
    files = [
        {
            "path": DATABASE_ARCHIVE_PATH,
            "sha256": sha256_file(database),
            "size": database.stat().st_size,
        },
        {
            "path": "payload/artifacts/paper-1/original.pdf",
            "sha256": sha256_file(artifact),
            "size": artifact.stat().st_size,
        },
    ]
    manifest = {
        "format": "hxaxd-learning-exact-v1",
        "created_at": "2026-01-01T00:00:00Z",
        "schema_sha256": "legacy-hash",
        "files": files,
    }
    with ZipFile(archive, "w", ZIP_DEFLATED) as output:
        output.writestr(MANIFEST_PATH, json.dumps(manifest))
        output.write(database, DATABASE_ARCHIVE_PATH)
        output.write(artifact, "payload/artifacts/paper-1/original.pdf")
