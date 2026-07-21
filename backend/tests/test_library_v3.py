from __future__ import annotations

from app.jobs import JobCreate, SqliteJobRepository
from app.library.models import GeneratedAttachment, LanguageMode
from app.library.repository import AttachmentRepository
from app.library.service import AttachmentService
from app.library.storage import AttachmentStorage
from app.platform.db import V3Database
from tests.sample_data import PDF


def _service(app_settings) -> tuple[V3Database, AttachmentService]:
    database = V3Database(app_settings.database_path)
    database.initialize()
    with database.transaction() as connection:
        connection.execute(
            "INSERT INTO works(id, created_at, updated_at) VALUES('work-1', ?, ?)",
            ("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
        )
        connection.execute(
            """
            INSERT INTO bibliographic_items(
                id, work_id, item_type, title, creator_list_complete,
                is_preferred_for_work, created_at, updated_at
            ) VALUES('item-1', 'work-1', 'preprint', 'Example', 1, 1, ?, ?)
            """,
            ("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
        )
    storage = AttachmentStorage(app_settings)
    storage.initialize()
    return database, AttachmentService(AttachmentRepository(database), storage)


def test_generated_outputs_are_registered_atomically_and_deduplicate_blobs(
    app_settings, tmp_path
):
    database, service = _service(app_settings)
    original = tmp_path / "original.pdf"
    translated = tmp_path / "translated.pdf"
    bilingual = tmp_path / "bilingual.pdf"
    original.write_bytes(PDF)
    translated.write_bytes(PDF)
    bilingual.write_bytes(PDF)

    parent = service.register_generated_batch(
        "item-1",
        [(original, GeneratedAttachment(filename="original.pdf", language_mode="original"))],
        parent_attachment_id=None,
        job_id=None,
    )[0]
    children = service.register_generated_batch(
        "item-1",
        [
            (translated, GeneratedAttachment(
                filename="translated.pdf", language_mode=LanguageMode.TRANSLATED
            )),
            (bilingual, GeneratedAttachment(
                filename="bilingual.pdf", language_mode=LanguageMode.BILINGUAL
            )),
        ],
        parent_attachment_id=parent.id,
        job_id=None,
    )

    assert len(children) == 2
    assert len(service.list_for_item("item-1")) == 3
    with database.read() as connection:
        assert connection.execute("SELECT COUNT(*) FROM blobs").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM blob_objects").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM attachment_relations").fetchone()[0] == 2


def test_relation_failure_rolls_back_database_and_committed_file(app_settings, tmp_path):
    database, service = _service(app_settings)
    generated = tmp_path / "generated.pdf"
    generated.write_bytes(PDF)

    try:
        service.register_generated_batch(
            "item-1",
            [(generated, GeneratedAttachment(filename="generated.pdf", language_mode="original"))],
            parent_attachment_id="missing-parent",
            job_id=None,
        )
    except Exception:
        pass
    else:
        raise AssertionError("missing parent relation should fail")

    assert service.list_for_item("item-1") == []
    with database.read() as connection:
        assert connection.execute("SELECT COUNT(*) FROM blobs").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM blob_objects").fetchone()[0] == 0
    assert list(app_settings.artifact_dir.rglob("*.pdf")) == []


def test_generated_outputs_are_idempotent_across_job_retries(app_settings, tmp_path):
    database, service = _service(app_settings)
    jobs = SqliteJobRepository(database.path)
    jobs.initialize_schema()
    job = jobs.enqueue(JobCreate(kind="attachment.download"))
    first_file = tmp_path / "first.pdf"
    retry_file = tmp_path / "retry.pdf"
    first_file.write_bytes(PDF)
    retry_file.write_bytes(PDF)

    first = service.register_generated_batch(
        "item-1",
        [(first_file, GeneratedAttachment(filename="paper.pdf", language_mode="original"))],
        parent_attachment_id=None,
        job_id=job.id,
        operation_roles=["output"],
    )[0]
    retried = service.register_generated_batch(
        "item-1",
        [(retry_file, GeneratedAttachment(filename="paper-again.pdf", language_mode="original"))],
        parent_attachment_id=None,
        job_id=job.id,
        operation_roles=["output"],
    )[0]

    assert retried.id == first.id
    assert len(service.list_for_item("item-1")) == 1
    with database.read() as connection:
        row = connection.execute(
            "SELECT created_by_job_id, operation_role FROM attachments"
        ).fetchone()
    assert tuple(row) == (job.id, "output")
