from __future__ import annotations

from datetime import UTC, datetime

from fastapi.testclient import TestClient

from app.integrations.zotero.models import (
    BibliographicDraft,
    ConflictChoice,
    ConflictResolution,
    TransferAction,
    TransferCandidate,
    TransferDirection,
    TransferItemReceipt,
    TransferPlanRequest,
    TransferReceipt,
    TransferStatus,
    ZoteroBinding,
    ZoteroLibraryKind,
    ZoteroLibraryRef,
)
from app.integrations.zotero.planner import ZoteroDiffPlanner
from app.integrations.zotero.repository import SqliteZoteroTransferRepository
from app.main import create_app
from app.platform.db import WorkspaceDatabase

NOW = datetime(2026, 7, 21, 8, 0, tzinfo=UTC)
LIBRARY = ZoteroLibraryRef(kind=ZoteroLibraryKind.USER, id="123")


def test_repository_can_be_wired_before_application_database_startup(tmp_path):
    database = WorkspaceDatabase(tmp_path / "research.sqlite3")
    repository = SqliteZoteroTransferRepository(database, clock=lambda: NOW)
    assert database.path.exists() is False

    database.initialize()
    assert repository.get_preview("missing") is None


def test_sqlite_repository_persists_preview_resolution_receipt_and_claim(tmp_path):
    database = WorkspaceDatabase(tmp_path / "research.sqlite3")
    database.initialize()
    repository = SqliteZoteroTransferRepository(database, clock=lambda: NOW)
    preview = ZoteroDiffPlanner(clock=lambda: NOW).plan(
        TransferPlanRequest(
            direction=TransferDirection.IMPORT,
            library=LIBRARY,
            project_id="project-1",
            items=[
                TransferCandidate(
                    item_id="remote-1",
                    source=BibliographicDraft(item_type="journalArticle", title="Paper"),
                )
            ],
        )
    )
    repository.save_preview(preview)
    repeated = preview.model_copy(update={"id": "preview-repeated"})
    repository.save_preview(repeated)
    repository.save_resolution(
        preview.id,
        ConflictResolution(conflict_id="conflict-1", choice=ConflictChoice.SKIP, resolved_at=NOW),
    )

    assert repository.claim_execution(preview.id, NOW) is True
    assert repository.claim_execution(preview.id, NOW) is False
    receipt = TransferReceipt(
        id="receipt-1",
        preview_id=preview.id,
        preview_hash=preview.preview_hash,
        status=TransferStatus.SUCCEEDED,
        started_at=NOW,
        finished_at=NOW,
        items=[
            TransferItemReceipt(
                item_id="remote-1",
                planned_action=TransferAction.NEW,
                outcome="created",
            )
        ],
    )
    repository.save_receipt(receipt)

    reopened = SqliteZoteroTransferRepository(database, clock=lambda: NOW)
    assert reopened.get_preview(preview.id) == preview
    assert reopened.get_preview(repeated.id) == repeated
    assert reopened.list_resolutions(preview.id)[0].choice == ConflictChoice.SKIP
    assert reopened.get_receipt(preview.id) == receipt


def test_sqlite_repository_persists_item_progress_and_releases_interrupted_claim(tmp_path):
    database = WorkspaceDatabase(tmp_path / "research.sqlite3")
    database.initialize()
    repository = SqliteZoteroTransferRepository(database, clock=lambda: NOW)
    preview = ZoteroDiffPlanner(clock=lambda: NOW).plan(
        TransferPlanRequest(
            direction=TransferDirection.IMPORT,
            library=LIBRARY,
            project_id="project-1",
            items=[
                TransferCandidate(
                    item_id="remote-1",
                    source=BibliographicDraft(item_type="journalArticle", title="Paper"),
                )
            ],
        )
    )
    repository.save_preview(preview)
    assert repository.claim_execution(preview.id, NOW) is True
    progress = TransferReceipt(
        id="receipt-progress",
        preview_id=preview.id,
        preview_hash=preview.preview_hash,
        status=TransferStatus.APPLYING,
        started_at=NOW,
        finished_at=None,
        items=[
            TransferItemReceipt(
                item_id="remote-1",
                planned_action=TransferAction.NEW,
                outcome="applying",
            )
        ],
    )
    repository.save_progress(progress)

    reopened = SqliteZoteroTransferRepository(database, clock=lambda: NOW)
    assert reopened.get_receipt(preview.id) == progress
    assert reopened.get_execution_state(preview.id) == TransferStatus.APPLYING
    assert reopened.reconcile_interrupted() == 1
    assert reopened.get_execution_state(preview.id) == TransferStatus.RECOVERABLE
    assert reopened.claim_execution(preview.id, NOW) is True

    completed = progress.model_copy(
        update={
            "status": TransferStatus.SUCCEEDED,
            "finished_at": NOW,
            "items": [
                TransferItemReceipt(
                    item_id="remote-1",
                    planned_action=TransferAction.NEW,
                    outcome="created",
                )
            ],
        }
    )
    reopened.save_receipt(completed)
    assert reopened.get_execution_state(preview.id) == TransferStatus.SUCCEEDED


def test_application_startup_marks_an_interrupted_transfer_recoverable(app_settings):
    database = WorkspaceDatabase(app_settings.database_path)
    database.initialize()
    repository = SqliteZoteroTransferRepository(database, clock=lambda: NOW)
    preview = ZoteroDiffPlanner(clock=lambda: NOW).plan(
        TransferPlanRequest(
            direction=TransferDirection.IMPORT,
            library=LIBRARY,
            project_id="project-1",
            items=[
                TransferCandidate(
                    item_id="remote-1",
                    source=BibliographicDraft(item_type="journalArticle", title="Paper"),
                )
            ],
        )
    )
    repository.save_preview(preview)
    assert repository.claim_execution(preview.id, NOW) is True
    repository.save_progress(
        TransferReceipt(
            id="startup-progress",
            preview_id=preview.id,
            preview_hash=preview.preview_hash,
            status=TransferStatus.APPLYING,
            started_at=NOW,
            items=[
                TransferItemReceipt(
                    item_id="remote-1",
                    planned_action=TransferAction.NEW,
                    outcome="applying",
                )
            ],
        )
    )

    application = create_app(app_settings)
    with TestClient(application):
        restored = application.state.context.zotero_service.get_public_preview(preview.id)

    assert restored.state == TransferStatus.RECOVERABLE
    assert restored.receipt is not None
    assert restored.receipt.items[0].outcome == "applying"


def test_sqlite_binding_can_follow_an_immutable_local_item_version(tmp_path):
    database = WorkspaceDatabase(tmp_path / "research.sqlite3")
    database.initialize()
    repository = SqliteZoteroTransferRepository(database, clock=lambda: NOW)
    first = ZoteroBinding(
        id="binding-1",
        library=LIBRARY,
        entity_type="bibliographic_item",
        entity_id="local-v1",
        external_key="REMOTE1",
        external_version=3,
        local_hash="a" * 64,
        remote_hash="b" * 64,
        project_id="project-1",
        created_at=NOW,
        updated_at=NOW,
    )
    repository.save_binding(first)
    repository.save_binding(
        first.model_copy(
            update={
                "entity_id": "local-v2",
                "external_version": 4,
                "local_hash": "c" * 64,
            }
        )
    )

    assert repository.get_binding_by_entity(LIBRARY, "bibliographic_item", "local-v1") is None
    moved = repository.get_binding_by_external(LIBRARY, "bibliographic_item", "REMOTE1")
    assert moved is not None
    assert moved.entity_id == "local-v2"
    assert moved.external_version == 4
