from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from typing import Protocol
from uuid import uuid4

from .models import (
    ConflictChoice,
    ConflictResolution,
    PublicTransferPreview,
    TransferAction,
    TransferCandidate,
    TransferExecuteRequest,
    TransferFingerprint,
    TransferItemReceipt,
    TransferPlanRequest,
    TransferPreview,
    TransferPreviewRequest,
    TransferReceipt,
    TransferStatus,
    ZoteroIntegrationStatus,
)
from .planner import ZoteroDiffPlanner
from .repository import ZoteroTransferRepository


class ZoteroTransferError(Exception):
    pass


class TransferNotFoundError(ZoteroTransferError):
    pass


class TransferConfirmationRequiredError(ZoteroTransferError):
    pass


class StaleTransferPreviewError(ZoteroTransferError):
    pass


class UnresolvedTransferConflictError(ZoteroTransferError):
    pass


class TransferAlreadyExecutingError(ZoteroTransferError):
    pass


class BlockedTransferItemError(ZoteroTransferError):
    pass


class ZoteroTransferExecutor(Protocol):
    def status(self) -> ZoteroIntegrationStatus: ...

    def build_candidates(self, request: TransferPreviewRequest) -> list[TransferCandidate]: ...

    def inspect(
        self, preview: TransferPreview
    ) -> dict[str, tuple[TransferFingerprint, TransferFingerprint | None]]: ...

    def apply(
        self,
        preview: TransferPreview,
        item,
        resolutions: Sequence[ConflictResolution],
    ) -> TransferItemReceipt: ...

    def recover(
        self,
        preview: TransferPreview,
        item,
        resolutions: Sequence[ConflictResolution],
    ) -> TransferItemReceipt | None: ...


class ZoteroApplicationService(Protocol):
    def status(self) -> ZoteroIntegrationStatus: ...

    def create_preview(self, request: TransferPreviewRequest) -> TransferPreview: ...

    def get_preview(self, preview_id: str) -> TransferPreview: ...

    def get_public_preview(self, preview_id: str) -> PublicTransferPreview: ...

    def resolve_conflict(
        self, preview_id: str, resolution: ConflictResolution
    ) -> ConflictResolution: ...

    def execute(self, preview_id: str, request: TransferExecuteRequest) -> TransferReceipt: ...

    def get_receipt(self, preview_id: str) -> TransferReceipt: ...

    def reconcile_interrupted(self) -> int: ...


class ZoteroTransferService:
    def __init__(
        self,
        repository: ZoteroTransferRepository,
        executor: ZoteroTransferExecutor,
        *,
        planner: ZoteroDiffPlanner | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.repository = repository
        self.executor = executor
        self._clock = clock or (lambda: datetime.now(UTC))
        self.planner = planner or ZoteroDiffPlanner(clock=self._clock)

    def status(self) -> ZoteroIntegrationStatus:
        return self.executor.status()

    def create_preview(self, request: TransferPreviewRequest) -> TransferPreview:
        candidates = self.executor.build_candidates(request)
        preview = self.planner.plan(
            TransferPlanRequest(
                **request.model_dump(mode="python"),
                items=candidates,
            )
        )
        self.repository.save_preview(preview)
        return preview

    def get_preview(self, preview_id: str) -> TransferPreview:
        preview = self.repository.get_preview(preview_id)
        if preview is None:
            raise TransferNotFoundError("Zotero transfer preview does not exist")
        return preview

    def get_public_preview(self, preview_id: str) -> PublicTransferPreview:
        preview = self.get_preview(preview_id)
        state = self.repository.get_execution_state(preview_id)
        if state is None:
            raise TransferNotFoundError("Zotero transfer preview does not exist")
        return PublicTransferPreview.from_internal(
            preview,
            state=state,
            resolutions=self.repository.list_resolutions(preview_id),
            receipt=self.repository.get_receipt(preview_id),
        )

    def resolve_conflict(
        self, preview_id: str, resolution: ConflictResolution
    ) -> ConflictResolution:
        preview = self.get_preview(preview_id)
        state = self.repository.get_execution_state(preview_id)
        if state != TransferStatus.PREVIEW_READY:
            raise TransferAlreadyExecutingError(
                "Zotero transfer conflicts are immutable after execution starts"
            )
        self._validate_not_expired(preview)
        known_conflicts = {conflict.id for item in preview.items for conflict in item.conflicts}
        if resolution.conflict_id not in known_conflicts:
            raise TransferNotFoundError("Zotero transfer conflict does not exist")
        stored = resolution.model_copy(update={"resolved_at": self._clock()})
        self.repository.save_resolution(preview_id, stored)
        return stored

    def execute(self, preview_id: str, request: TransferExecuteRequest) -> TransferReceipt:
        preview = self.get_preview(preview_id)
        self._validate_confirmation(preview, request)
        progress = self.repository.get_receipt(preview_id)
        if progress is not None and progress.status != TransferStatus.APPLYING:
            return progress
        if progress is None:
            self._validate_not_expired(preview)
        resolutions = self.repository.list_resolutions(preview_id)
        self._validate_no_blocked_items(preview)
        self._validate_conflicts(preview, resolutions)
        checkpointed_ids = {item.item_id for item in progress.items} if progress else set()
        self._validate_fingerprints(preview, checkpointed_ids=checkpointed_ids)

        started_at = progress.started_at if progress is not None else self._clock()
        if not self.repository.claim_execution(preview.id, started_at):
            existing_receipt = self.repository.get_receipt(preview_id)
            if (
                existing_receipt is not None
                and existing_receipt.status != TransferStatus.APPLYING
            ):
                return existing_receipt
            raise TransferAlreadyExecutingError("Zotero transfer is already executing")
        receipt_id = progress.id if progress is not None else uuid4().hex
        prior_items = progress.items if progress else []
        receipts_by_item = {
            item.item_id: item.model_copy(deep=True) for item in prior_items
        }
        resolutions_by_conflict = {item.conflict_id: item for item in resolutions}
        for item in preview.items:
            checkpoint = receipts_by_item.get(item.item_id)
            if checkpoint is not None and checkpoint.outcome != "applying":
                continue
            recovering_item = checkpoint is not None
            item_resolutions = [
                resolutions_by_conflict[conflict.id]
                for conflict in item.conflicts
                if conflict.id in resolutions_by_conflict
            ]
            if item.action == TransferAction.BLOCKED or any(
                resolution.choice in {ConflictChoice.TARGET, ConflictChoice.SKIP}
                for resolution in item_resolutions
            ):
                receipts_by_item[item.item_id] = TransferItemReceipt(
                    item_id=item.item_id,
                    planned_action=item.action,
                    outcome="skipped",
                    message=item.blocked_reason or "Conflict resolution kept the target.",
                )
                self._save_progress(
                    preview,
                    receipt_id,
                    started_at,
                    self._ordered_receipts(preview, receipts_by_item),
                )
                continue
            receipts_by_item[item.item_id] = TransferItemReceipt(
                item_id=item.item_id,
                planned_action=item.action,
                outcome="applying",
                message="Execution intent was checkpointed before applying this item.",
            )
            self._save_progress(
                preview,
                receipt_id,
                started_at,
                self._ordered_receipts(preview, receipts_by_item),
            )
            try:
                recover = getattr(self.executor, "recover", None)
                applied = (
                    recover(preview, item, item_resolutions)
                    if recovering_item and callable(recover)
                    else None
                )
                if applied is None:
                    applied = self.executor.apply(preview, item, item_resolutions)
                if applied.item_id != item.item_id or applied.planned_action != item.action:
                    raise RuntimeError("Zotero executor returned a receipt for another plan item")
                if applied.outcome == "applying":
                    raise RuntimeError("Zotero executor returned an unfinished item receipt")
                receipts_by_item[item.item_id] = applied
            except Exception as error:  # executor errors become an auditable partial receipt
                recovered = None
                if callable(recover):
                    try:
                        recovered = recover(preview, item, item_resolutions)
                    except Exception:
                        recovered = None
                receipts_by_item[item.item_id] = recovered or TransferItemReceipt(
                    item_id=item.item_id,
                    planned_action=item.action,
                    outcome="failed",
                    message=str(error),
                )
            self._save_progress(
                preview,
                receipt_id,
                started_at,
                self._ordered_receipts(preview, receipts_by_item),
            )

        receipts = self._ordered_receipts(preview, receipts_by_item)
        receipt = TransferReceipt(
            id=receipt_id,
            preview_id=preview.id,
            preview_hash=preview.preview_hash,
            status=_receipt_status(receipts),
            started_at=started_at,
            finished_at=self._clock(),
            items=receipts,
        )
        self.repository.save_receipt(receipt)
        return receipt

    def get_receipt(self, preview_id: str) -> TransferReceipt:
        receipt = self.repository.get_receipt(preview_id)
        if receipt is None:
            raise TransferNotFoundError("Zotero transfer receipt does not exist")
        return receipt

    def reconcile_interrupted(self) -> int:
        return self.repository.reconcile_interrupted()

    def _save_progress(
        self,
        preview: TransferPreview,
        receipt_id: str,
        started_at: datetime,
        items: list[TransferItemReceipt],
    ) -> None:
        self.repository.save_progress(
            TransferReceipt(
                id=receipt_id,
                preview_id=preview.id,
                preview_hash=preview.preview_hash,
                status=TransferStatus.APPLYING,
                started_at=started_at,
                finished_at=None,
                items=items,
            )
        )

    @staticmethod
    def _ordered_receipts(
        preview: TransferPreview,
        receipts: dict[str, TransferItemReceipt],
    ) -> list[TransferItemReceipt]:
        return [receipts[item.item_id] for item in preview.items if item.item_id in receipts]

    @staticmethod
    def _validate_confirmation(preview: TransferPreview, request: TransferExecuteRequest) -> None:
        if not request.confirmed:
            raise TransferConfirmationRequiredError(
                "Zotero transfer execution requires explicit confirmation"
            )
        if request.expected_preview_hash != preview.preview_hash:
            raise StaleTransferPreviewError("Zotero transfer preview hash does not match")

    def _validate_not_expired(self, preview: TransferPreview) -> None:
        if self._clock() >= preview.expires_at:
            raise StaleTransferPreviewError("Zotero transfer preview has expired")

    @staticmethod
    def _validate_no_blocked_items(preview: TransferPreview) -> None:
        blocked = [item.item_id for item in preview.items if item.action == TransferAction.BLOCKED]
        if blocked:
            raise BlockedTransferItemError(
                f"Zotero transfer has {len(blocked)} blocked item(s)"
            )

    @staticmethod
    def _validate_conflicts(
        preview: TransferPreview, resolutions: Sequence[ConflictResolution]
    ) -> None:
        resolved = {resolution.conflict_id for resolution in resolutions}
        unresolved = [
            conflict.id
            for item in preview.items
            for conflict in item.conflicts
            if conflict.id not in resolved
        ]
        if unresolved:
            raise UnresolvedTransferConflictError(
                f"Zotero transfer has {len(unresolved)} unresolved conflict(s)"
            )

    def _validate_fingerprints(
        self,
        preview: TransferPreview,
        *,
        checkpointed_ids: set[str],
    ) -> None:
        current = self.executor.inspect(preview)
        planned_ids = {item.item_id for item in preview.items}
        if not checkpointed_ids and set(current) != planned_ids:
            raise StaleTransferPreviewError("Zotero transfer scope changed after preview")
        for item in preview.items:
            if item.item_id in checkpointed_ids:
                continue
            state = current.get(item.item_id)
            if state is None:
                raise StaleTransferPreviewError(
                    f"Transfer item {item.item_id} can no longer be inspected"
                )
            source, target = state
            if source != item.source_fingerprint or target != item.target_fingerprint:
                raise StaleTransferPreviewError(
                    f"Transfer item {item.item_id} changed after preview"
                )


def _receipt_status(items: Sequence[TransferItemReceipt]) -> TransferStatus:
    failed = sum(item.outcome == "failed" for item in items)
    completed = sum(item.outcome in {"created", "updated", "unchanged"} for item in items)
    if failed and completed:
        return TransferStatus.PARTIAL
    if failed:
        return TransferStatus.FAILED
    return TransferStatus.SUCCEEDED
