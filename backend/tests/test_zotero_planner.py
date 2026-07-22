from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.integrations.zotero.models import (
    BibliographicDraft,
    ConflictChoice,
    ConflictResolution,
    SyncBaseline,
    TransferAction,
    TransferCandidate,
    TransferDirection,
    TransferExecuteRequest,
    TransferFingerprint,
    TransferItemReceipt,
    TransferPlanRequest,
    TransferPreviewRequest,
    TransferStatus,
    ZoteroEndpointStatus,
    ZoteroIntegrationStatus,
    ZoteroLibraryKind,
    ZoteroLibraryRef,
)
from app.integrations.zotero.planner import ZoteroDiffPlanner, fingerprint
from app.integrations.zotero.repository import SqliteZoteroTransferRepository
from app.integrations.zotero.service import (
    StaleTransferPreviewError,
    TransferConfirmationRequiredError,
    UnresolvedTransferConflictError,
    ZoteroTransferService,
)
from app.platform.db import WorkspaceDatabase

NOW = datetime(2026, 7, 21, 8, 0, tzinfo=UTC)
LIBRARY = ZoteroLibraryRef(kind=ZoteroLibraryKind.USER, id="123")


def _draft(title: str, *, key: str | None = None, version: int | None = None):
    return BibliographicDraft(
        external_key=key,
        external_version=version,
        item_type="journalArticle",
        title=title,
    )


def _baseline(source: BibliographicDraft, target: BibliographicDraft) -> SyncBaseline:
    return SyncBaseline(
        source_hash=fingerprint(source).content_hash,
        target_hash=fingerprint(target).content_hash,
        source_version=source.external_version,
        target_version=target.external_version,
    )


def test_planner_deterministically_classifies_every_diff_action():
    old_source = _draft("Old", key="source-old", version=1)
    old_target = _draft("Old", key="target-old", version=10)
    changed_source = _draft("Changed", key="source-old", version=2)
    changed_target = _draft("Changed elsewhere", key="target-old", version=11)
    request = TransferPlanRequest(
        direction=TransferDirection.IMPORT,
        library=LIBRARY,
        project_id="project-1",
        items=[
            TransferCandidate(item_id="new", source=_draft("New", key="new", version=1)),
            TransferCandidate(
                item_id="same",
                source=_draft("Same", key="source", version=1),
                target=_draft("Same", key="target", version=9),
            ),
            TransferCandidate(
                item_id="update",
                source=changed_source,
                target=old_target,
                baseline=_baseline(old_source, old_target),
            ),
            TransferCandidate(
                item_id="conflict",
                source=changed_source,
                target=changed_target,
                baseline=_baseline(old_source, old_target),
            ),
            TransferCandidate(
                item_id="blocked", source=_draft(""), blocked_reason="No supported type"
            ),
        ],
    )
    planner = ZoteroDiffPlanner(clock=lambda: NOW)

    first = planner.plan(request)
    second = planner.plan(request)

    assert [item.action for item in first.items] == [
        TransferAction.NEW,
        TransferAction.UNCHANGED,
        TransferAction.UPDATE,
        TransferAction.CONFLICT,
        TransferAction.BLOCKED,
    ]
    assert first.summary.model_dump() == {
        "total": 5,
        "new": 1,
        "update": 1,
        "unchanged": 1,
        "conflict": 1,
        "blocked": 1,
    }
    assert first.preview_hash == second.preview_hash
    assert first.items[2].source_fingerprint.version == 2
    assert first.items[2].target_fingerprint.version == 10
    assert first.items[3].conflicts[0].fields == ["title"]


class FakeExecutor:
    def __init__(self, *, conflict: bool = False):
        self.conflict = conflict
        self.states: dict[str, tuple[TransferFingerprint, TransferFingerprint | None]] = {}
        self.applied: list[str] = []

    def status(self):
        endpoint = ZoteroEndpointStatus(available=True, read_only=False, message="ready")
        return ZoteroIntegrationStatus(
            local=endpoint.model_copy(update={"read_only": True}),
            web=endpoint,
            import_available=True,
            export_available=True,
        )

    def build_candidates(self, request):
        del request
        target = _draft("Target", key="target", version=3) if self.conflict else None
        return [TransferCandidate(item_id="item", source=_draft("Source"), target=target)]

    def inspect(self, preview):
        if not self.states:
            self.states = {
                item.item_id: (item.source_fingerprint, item.target_fingerprint)
                for item in preview.items
            }
        return self.states

    def apply(self, preview, item, resolutions):
        del preview, resolutions
        self.applied.append(item.item_id)
        return TransferItemReceipt(
            item_id=item.item_id,
            planned_action=item.action,
            outcome="created" if item.action == TransferAction.NEW else "updated",
            external_key="REMOTEKEY",
            external_version=99,
        )


def _service_request() -> TransferPreviewRequest:
    return TransferPreviewRequest(
        direction=TransferDirection.EXPORT,
        library=LIBRARY,
        project_id="project-1",
    )


def _repository(tmp_path) -> SqliteZoteroTransferRepository:
    database = WorkspaceDatabase(tmp_path / "research.sqlite3")
    database.initialize()
    return SqliteZoteroTransferRepository(database, clock=lambda: NOW)


def test_execute_requires_confirmation_matching_hash_and_current_fingerprints(tmp_path):
    repository = _repository(tmp_path)
    executor = FakeExecutor()
    service = ZoteroTransferService(
        repository,
        executor,
        planner=ZoteroDiffPlanner(clock=lambda: NOW),
        clock=lambda: NOW,
    )
    preview = service.create_preview(_service_request())

    with pytest.raises(TransferConfirmationRequiredError):
        service.execute(
            preview.id,
            TransferExecuteRequest(confirmed=False, expected_preview_hash=preview.preview_hash),
        )
    with pytest.raises(StaleTransferPreviewError):
        service.execute(
            preview.id,
            TransferExecuteRequest(confirmed=True, expected_preview_hash="0" * 64),
        )

    executor.inspect(preview)
    original_source, target = executor.states["item"]
    executor.states["item"] = (
        original_source.model_copy(update={"version": 999}),
        target,
    )
    with pytest.raises(StaleTransferPreviewError):
        service.execute(
            preview.id,
            TransferExecuteRequest(confirmed=True, expected_preview_hash=preview.preview_hash),
        )


def test_conflict_must_be_resolved_before_an_explicit_execution(tmp_path):
    repository = _repository(tmp_path)
    executor = FakeExecutor(conflict=True)
    service = ZoteroTransferService(
        repository,
        executor,
        planner=ZoteroDiffPlanner(clock=lambda: NOW),
        clock=lambda: NOW,
    )
    preview = service.create_preview(_service_request())
    execute = TransferExecuteRequest(confirmed=True, expected_preview_hash=preview.preview_hash)

    with pytest.raises(UnresolvedTransferConflictError):
        service.execute(preview.id, execute)

    conflict = preview.items[0].conflicts[0]
    service.resolve_conflict(
        preview.id,
        ConflictResolution(conflict_id=conflict.id, choice=ConflictChoice.SOURCE),
    )
    prepared = service.get_public_preview(preview.id)
    assert prepared.state == TransferStatus.PREVIEW_READY
    assert prepared.resolutions[0].conflict_id == conflict.id
    assert prepared.receipt is None
    receipt = service.execute(preview.id, execute)

    assert receipt.status == "succeeded"
    assert receipt.items[0].outcome == "updated"
    assert executor.applied == ["item"]
    assert service.get_receipt(preview.id) == receipt
    assert service.execute(preview.id, execute) == receipt
    assert executor.applied == ["item"]


def test_expired_preview_is_rejected(tmp_path):
    current = NOW
    repository = _repository(tmp_path)
    executor = FakeExecutor()
    service = ZoteroTransferService(
        repository,
        executor,
        planner=ZoteroDiffPlanner(clock=lambda: NOW),
        clock=lambda: current,
    )
    preview = service.create_preview(_service_request())
    current = NOW + timedelta(days=2)

    with pytest.raises(StaleTransferPreviewError):
        service.execute(
            preview.id,
            TransferExecuteRequest(confirmed=True, expected_preview_hash=preview.preview_hash),
        )


class SimulatedProcessExit(BaseException):
    pass


class RecoverableExecutor(FakeExecutor):
    def __init__(self, *, fail_normally: bool = False):
        super().__init__()
        self.fail_normally = fail_normally
        self.effects: set[str] = set()
        self.calls: dict[str, int] = {}

    def build_candidates(self, request):
        del request
        return [
            TransferCandidate(item_id="first", source=_draft("First")),
            TransferCandidate(item_id="second", source=_draft("Second")),
        ]

    def apply(self, preview, item, resolutions):
        del preview, resolutions
        self.calls[item.item_id] = self.calls.get(item.item_id, 0) + 1
        if item.item_id == "second" and self.calls[item.item_id] == 1:
            if self.fail_normally:
                raise RuntimeError("remote write failed")
            self.effects.add(item.item_id)
            raise SimulatedProcessExit()
        self.effects.add(item.item_id)
        return TransferItemReceipt(
            item_id=item.item_id,
            planned_action=item.action,
            outcome="created",
        )

    def recover(self, preview, item, resolutions):
        del preview, resolutions
        if item.item_id not in self.effects:
            return None
        return TransferItemReceipt(
            item_id=item.item_id,
            planned_action=item.action,
            outcome="created",
            message="recovered",
        )


def test_interrupted_execution_resumes_from_item_checkpoints_after_restart(tmp_path):
    database = WorkspaceDatabase(tmp_path / "research.sqlite3")
    database.initialize()
    repository = SqliteZoteroTransferRepository(database, clock=lambda: NOW)
    executor = RecoverableExecutor()
    service = ZoteroTransferService(
        repository,
        executor,
        planner=ZoteroDiffPlanner(clock=lambda: NOW),
        clock=lambda: NOW,
    )
    preview = service.create_preview(_service_request())
    execute = TransferExecuteRequest(confirmed=True, expected_preview_hash=preview.preview_hash)

    with pytest.raises(SimulatedProcessExit):
        service.execute(preview.id, execute)

    progress = service.get_public_preview(preview.id)
    assert progress.state == TransferStatus.APPLYING
    assert progress.receipt is not None
    assert [item.outcome for item in progress.receipt.items] == ["created", "applying"]

    restarted_repository = SqliteZoteroTransferRepository(database, clock=lambda: NOW)
    restarted = ZoteroTransferService(
        restarted_repository,
        executor,
        planner=ZoteroDiffPlanner(clock=lambda: NOW),
        clock=lambda: NOW,
    )
    assert restarted.reconcile_interrupted() == 1
    assert restarted.get_public_preview(preview.id).state == TransferStatus.RECOVERABLE

    receipt = restarted.execute(preview.id, execute)
    assert receipt.status == TransferStatus.SUCCEEDED
    assert [item.outcome for item in receipt.items] == ["created", "created"]
    assert executor.calls == {"first": 1, "second": 1}
    assert restarted.execute(preview.id, execute) == receipt
    assert executor.calls == {"first": 1, "second": 1}


def test_regular_item_failure_finishes_with_a_stable_partial_receipt(tmp_path):
    repository = _repository(tmp_path)
    executor = RecoverableExecutor(fail_normally=True)
    service = ZoteroTransferService(
        repository,
        executor,
        planner=ZoteroDiffPlanner(clock=lambda: NOW),
        clock=lambda: NOW,
    )
    preview = service.create_preview(_service_request())
    execute = TransferExecuteRequest(confirmed=True, expected_preview_hash=preview.preview_hash)

    receipt = service.execute(preview.id, execute)

    assert receipt.status == TransferStatus.PARTIAL
    assert [item.outcome for item in receipt.items] == ["created", "failed"]
    assert service.execute(preview.id, execute) == receipt
    assert executor.calls == {"first": 1, "second": 1}
