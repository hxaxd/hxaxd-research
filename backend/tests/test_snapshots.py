from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.jobs.models import JobCreate, JobStatus
from app.jobs.repository import SqliteJobRepository
from app.jobs.scheduler import JobExecutionContext, JobRegistry, JobScheduler, JobWorker
from app.platform.activation import (
    ActivationError,
    activate_snapshot_directory,
    recover_pending_activation,
)
from app.platform.db import WorkspaceDatabase
from app.platform.processes import CancellationToken
from app.snapshots.models import SnapshotRestoreRequest
from app.snapshots.router import create_snapshot_router
from app.snapshots.service import SnapshotBusyError, SnapshotService
from app.utils.snapshots.backup import SnapshotWriter
from app.utils.snapshots.contract import (
    DATABASE_ARCHIVE_PATH,
    SnapshotManifest,
)
from app.utils.snapshots.errors import SnapshotError
from app.utils.snapshots.paths import payload_relative_path
from app.utils.snapshots.restore import SnapshotRestorer
from tests.sample_data import PDF

NOW = "2026-07-21T00:00:00+00:00"


class _SimulatedProcessCrash(BaseException):
    pass


def test_current_snapshot_round_trip_preserves_catalog_and_blob(tmp_path):
    data_dir, database, storage_key = _create_current_workspace(tmp_path / "source")
    archive = tmp_path / "today.researchpack"

    written = SnapshotWriter(data_dir, database).write(archive)
    restored_dir = tmp_path / "restored"
    restored = SnapshotRestorer().restore(archive, restored_dir)

    assert written.file_count == 2
    assert restored.file_count == 2
    assert restored.source_format == "hxaxd-research-v4"
    restored.database.verify()
    with restored.database.read() as connection:
        assert connection.execute("SELECT COUNT(*) FROM bibliographic_items").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM attachments").fetchone()[0] == 1
    assert (restored_dir / storage_key).read_bytes() == PDF


def test_writer_rejects_other_active_jobs_and_omits_its_own_control_job(tmp_path):
    data_dir, database, _ = _create_current_workspace(tmp_path / "source")
    jobs = SqliteJobRepository(database.path)
    jobs.initialize_schema()
    active = jobs.enqueue(JobCreate(kind="snapshot.create"))

    with pytest.raises(SnapshotError, match="尚未结束"):
        SnapshotWriter(data_dir, database).write(tmp_path / "blocked.researchpack")

    archive = tmp_path / "allowed.researchpack"
    SnapshotWriter(data_dir, database).write(archive, operation_job_id=active.id)
    restored = SnapshotRestorer().restore(archive, tmp_path / "restored")
    with restored.database.read() as connection:
        assert connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
        audit = connection.execute(
            "SELECT action FROM audit_events WHERE action='snapshot.control_job_omitted'"
        ).fetchone()
    assert audit is not None


@pytest.mark.parametrize(
    ("format_", "schema_version", "contract_version"),
    [
        ("hxaxd-learning-v2", 2, "2.0"),
        ("hxaxd-research-v3", 3, "3.0"),
    ],
)
def test_snapshot_manifest_rejects_retired_formats(
    format_: str,
    schema_version: int,
    contract_version: str,
):
    payload = {
        "format": format_,
        "created_at": NOW,
        "schema_version": schema_version,
        "contract_version": contract_version,
        "files": [
            {"path": DATABASE_ARCHIVE_PATH, "sha256": "0" * 64, "size": 0},
        ],
    }

    with pytest.raises(SnapshotError, match="格式不受支持"):
        SnapshotManifest.from_json(json.dumps(payload))


def test_restore_requires_explicit_replace(tmp_path):
    data_dir, database, _ = _create_current_workspace(tmp_path / "source")
    archive = tmp_path / "today.researchpack"
    SnapshotWriter(data_dir, database).write(archive)
    target = tmp_path / "occupied"
    target.mkdir()
    (target / "keep.txt").write_text("keep", encoding="utf-8")

    with pytest.raises(SnapshotError, match="必须显式使用 --replace"):
        SnapshotRestorer().restore(archive, target)


def test_restore_failure_before_activation_preserves_current_workspace(tmp_path):
    source_dir, source_database, _ = _create_current_workspace(tmp_path / "source")
    archive = tmp_path / "today.researchpack"
    SnapshotWriter(source_dir, source_database).write(archive)
    target_dir, target_database, _ = _create_current_workspace(tmp_path / "target")
    _seed_second_item(target_database)

    def report_busy() -> None:
        raise SnapshotError("workspace became busy")

    with pytest.raises(SnapshotError, match="became busy"):
        SnapshotRestorer().restore(
            archive,
            target_dir,
            replace=True,
            source_idle_check=report_busy,
        )

    target_database.verify()
    with target_database.read() as connection:
        assert connection.execute("SELECT COUNT(*) FROM bibliographic_items").fetchone()[0] == 2
    assert not list(tmp_path.glob("target.before-restore-*"))


def test_snapshot_activation_is_replayed_after_process_crash_in_rename_window(tmp_path):
    source_dir, _, _ = _create_current_workspace(tmp_path / "source")
    target_dir, target_database, _ = _create_current_workspace(tmp_path / "target")
    _seed_second_item(target_database)
    temporary_root = tmp_path / ".snapshot-restore-fault"
    stage = temporary_root / "data"
    shutil.copytree(source_dir, stage)
    recovery = tmp_path / "target.before-restore-fault"
    journal_path = tmp_path / ".runtime" / "workspace-activation.json"

    def crash(point: str) -> None:
        if point == "snapshot.after_source_moved":
            raise _SimulatedProcessCrash

    with pytest.raises(_SimulatedProcessCrash):
        activate_snapshot_directory(
            stage,
            target_dir,
            recovery,
            journal_path=journal_path,
            fault_injector=crash,
        )

    assert not target_dir.exists()
    assert recovery.is_dir()
    assert journal_path.is_file()

    recovered = recover_pending_activation(
        journal_path,
        data_dir=target_dir,
    )

    assert recovered == "snapshot_restore:committed"
    assert not journal_path.exists()
    with WorkspaceDatabase(target_dir / "research.sqlite3").read() as connection:
        assert connection.execute("SELECT COUNT(*) FROM bibliographic_items").fetchone()[0] == 1
    with WorkspaceDatabase(recovery / "research.sqlite3").read() as connection:
        assert connection.execute("SELECT COUNT(*) FROM bibliographic_items").fetchone()[0] == 2


def test_unjournaled_activation_residue_never_initializes_an_empty_database(tmp_path):
    from app.core.bootstrap import build_app_context

    settings = _settings(tmp_path)
    settings.data_dir.mkdir(parents=True)
    residue = settings.data_dir.parent / ".snapshot-restore-orphan"
    residue.mkdir()
    context = build_app_context(settings)

    with pytest.raises(ActivationError, match="拒绝初始化空库"):
        context.startup()

    assert not settings.database_path.exists()
    context.process_runner.shutdown()


def test_startup_rejects_a_retired_database_without_rewriting_it(tmp_path):
    from app.core.bootstrap import build_app_context

    settings = _settings(tmp_path)
    settings.data_dir.mkdir(parents=True)
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("CREATE TABLE papers(id TEXT PRIMARY KEY)")
        connection.execute("INSERT INTO papers VALUES('preserved')")
    context = build_app_context(settings)

    with pytest.raises(RuntimeError, match="当前 v4 格式"):
        context.startup()

    with sqlite3.connect(settings.database_path) as connection:
        assert connection.execute("SELECT id FROM papers").fetchone()[0] == "preserved"
    context.process_runner.shutdown()


@pytest.mark.parametrize("path", ["research.sqlite3", "../payload/file", "/payload/file"])
def test_payload_paths_cannot_escape_archive(path):
    with pytest.raises(SnapshotError):
        payload_relative_path(path)


def test_snapshot_jobs_are_durable_and_restore_job_survives_database_swap(tmp_path):
    settings = _settings(tmp_path)
    data_dir, database, _ = _create_current_workspace(settings.data_dir)
    assert data_dir == settings.data_dir
    archive = settings.snapshot_dir / "baseline.researchpack"
    settings.snapshot_dir.mkdir(parents=True)
    SnapshotWriter(data_dir, database).write(archive)
    _seed_second_item(database)

    jobs = SqliteJobRepository(database.path)
    jobs.initialize_schema()
    registry = JobRegistry()
    worker = JobWorker(jobs, registry, worker_id="snapshot-test")
    scheduler = JobScheduler(jobs, worker)
    service = SnapshotService(settings, database, jobs, scheduler)
    service.initialize()
    service.register_handlers(registry)

    restore_job = service.restore(
        archive.name,
        SnapshotRestoreRequest(confirmation=archive.name),
    )
    assert restore_job.status is JobStatus.QUEUED
    assert worker.run_once()

    restored_job = jobs.get(restore_job.id)
    assert restored_job.status is JobStatus.SUCCEEDED
    assert restored_job.result is not None
    assert restored_job.result["source_format"] == "hxaxd-research-v4"
    recovery = Path(restored_job.result["recovery_directory"])
    assert recovery.is_dir()
    WorkspaceDatabase(settings.database_path).verify()
    with WorkspaceDatabase(settings.database_path).read() as connection:
        assert connection.execute("SELECT COUNT(*) FROM bibliographic_items").fetchone()[0] == 1
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM audit_events WHERE action='workspace.restored'"
            ).fetchone()[0]
            == 1
        )


def test_snapshot_service_enqueues_creation_and_router_exposes_job(tmp_path):
    settings = _settings(tmp_path)
    _, database, _ = _create_current_workspace(settings.data_dir)
    jobs = SqliteJobRepository(database.path)
    jobs.initialize_schema()
    registry = JobRegistry()
    worker = JobWorker(jobs, registry, worker_id="snapshot-test")
    scheduler = JobScheduler(jobs, worker)
    service = SnapshotService(settings, database, jobs, scheduler)
    service.initialize()
    service.register_handlers(registry)
    app = FastAPI()
    app.include_router(create_snapshot_router(lambda: service), prefix="/api")

    with TestClient(app) as client:
        response = client.post("/api/snapshots")
        assert response.status_code == 202
        job_id = response.json()["id"]
        assert jobs.get(job_id).status is JobStatus.QUEUED
        assert client.get("/api/snapshots").json() == {"snapshots": []}

    with pytest.raises(SnapshotBusyError):
        service.create()

    assert worker.run_once()
    completed = jobs.get(job_id)
    assert completed.status is JobStatus.SUCCEEDED
    assert service.overview().snapshots[0].filename == completed.result["filename"]


def test_cancelled_snapshot_job_never_publishes_an_archive(tmp_path):
    settings = _settings(tmp_path)
    _, database, _ = _create_current_workspace(settings.data_dir)
    jobs = SqliteJobRepository(database.path)
    jobs.initialize_schema()
    registry = JobRegistry()
    worker = JobWorker(jobs, registry, worker_id="snapshot-test")
    scheduler = JobScheduler(jobs, worker)
    service = SnapshotService(settings, database, jobs, scheduler)
    service.initialize()
    service.register_handlers(registry)

    queued = service.create()
    canceled = scheduler.cancel(queued.id)

    assert canceled.status is JobStatus.CANCELED
    assert not worker.run_once()
    assert service.overview().snapshots == []


def test_published_snapshot_is_reconciled_after_worker_crash(tmp_path):
    settings = _settings(tmp_path)
    _, database, _ = _create_current_workspace(settings.data_dir)
    jobs = SqliteJobRepository(database.path)
    jobs.initialize_schema()
    scheduler = JobScheduler(jobs)
    service = SnapshotService(settings, database, jobs, scheduler)
    service.initialize()
    queued = service.create()
    claimed = jobs.claim_next("dead-snapshot-worker")
    assert claimed is not None and claimed.job.id == queued.id
    context = JobExecutionContext(
        claimed=claimed,
        cancellation=CancellationToken(),
        emit=lambda *_args: None,
        record_process=lambda *_args: None,
    )

    result = service._create_handler(context)
    assert result.commit_point_reached
    assert jobs.get(queued.id).status is JobStatus.RUNNING
    assert service.locate(result.result["filename"]).is_file()

    assert service.reconcile_committed() == 1
    recovered = jobs.get(queued.id)
    assert recovered.status is JobStatus.SUCCEEDED
    assert recovered.result["filename"] == result.result["filename"]


def _settings(tmp_path: Path) -> Settings:
    data_dir = (tmp_path / "data").resolve()
    return Settings(
        data_dir=data_dir,
        database_path=data_dir / "research.sqlite3",
        artifact_dir=data_dir / "artifacts",
        tools_dir=tmp_path / ".tools",
        snapshot_dir=tmp_path / "snapshots",
        frontend_origins=("http://testserver",),
    )


def _create_current_workspace(root: Path) -> tuple[Path, WorkspaceDatabase, str]:
    data_dir = root.resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    database = WorkspaceDatabase(data_dir / "research.sqlite3")
    database.initialize()
    storage_key = "artifacts/item-1/fulltext/source.pdf"
    artifact = data_dir / storage_key
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_bytes(PDF)
    digest = hashlib.sha256(PDF).hexdigest()
    with database.transaction() as connection:
        connection.execute("INSERT INTO works VALUES('work-1', ?, ?)", (NOW, NOW))
        connection.execute(
            """
            INSERT INTO bibliographic_items(
                id, work_id, item_type, title, is_preferred_for_work, created_at, updated_at
            ) VALUES('item-1', 'work-1', 'journalArticle', 'Snapshot Paper', 1, ?, ?)
            """,
            (NOW, NOW),
        )
        connection.execute(
            """
            INSERT INTO blobs(id, sha256, size, media_type, created_at)
            VALUES('blob-1', ?, ?, 'application/pdf', ?)
            """,
            (digest, len(PDF), NOW),
        )
        connection.execute(
            """
            INSERT INTO blob_objects(
                id, blob_id, storage_backend, storage_key, is_primary, state, created_at
            ) VALUES('object-1', 'blob-1', 'local', ?, 1, 'available', ?)
            """,
            (storage_key, NOW),
        )
        connection.execute(
            """
            INSERT INTO attachments(
                id, item_id, blob_id, attachment_type, format, language_mode,
                origin, filename, created_at
            ) VALUES(
                'attachment-1', 'item-1', 'blob-1', 'fulltext', 'pdf',
                'original', 'test', 'source.pdf', ?
            )
            """,
            (NOW,),
        )
    return data_dir, database, storage_key


def _seed_second_item(database: WorkspaceDatabase) -> None:
    with database.transaction() as connection:
        connection.execute("INSERT INTO works VALUES('work-2', ?, ?)", (NOW, NOW))
        connection.execute(
            """
            INSERT INTO bibliographic_items(
                id, work_id, item_type, title, is_preferred_for_work, created_at, updated_at
            ) VALUES('item-2', 'work-2', 'journalArticle', 'Later Paper', 1, ?, ?)
            """,
            (NOW, NOW),
        )
