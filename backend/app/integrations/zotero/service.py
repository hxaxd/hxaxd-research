from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from typing import Protocol
from uuid import uuid4

from .models import (
    ConflictChoice,
    ConflictResolution,
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


class ZoteroApplicationService(Protocol):
    def status(self) -> ZoteroIntegrationStatus: ...

    def create_preview(self, request: TransferPreviewRequest) -> TransferPreview: ...

    def get_preview(self, preview_id: str) -> TransferPreview: ...

    def resolve_conflict(
        self, preview_id: str, resolution: ConflictResolution
    ) -> ConflictResolution: ...

    def execute(self, preview_id: str, request: TransferExecuteRequest) -> TransferReceipt: ...

    def get_receipt(self, preview_id: str) -> TransferReceipt: ...


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

    def resolve_conflict(
        self, preview_id: str, resolution: ConflictResolution
    ) -> ConflictResolution:
        preview = self.get_preview(preview_id)
        known_conflicts = {conflict.id for item in preview.items for conflict in item.conflicts}
        if resolution.conflict_id not in known_conflicts:
            raise TransferNotFoundError("Zotero transfer conflict does not exist")
        stored = resolution.model_copy(update={"resolved_at": self._clock()})
        self.repository.save_resolution(preview_id, stored)
        return stored

    def execute(self, preview_id: str, request: TransferExecuteRequest) -> TransferReceipt:
        preview = self.get_preview(preview_id)
        self._validate_confirmation(preview, request)
        existing_receipt = self.repository.get_receipt(preview_id)
        if existing_receipt is not None:
            return existing_receipt
        self._validate_not_expired(preview)
        resolutions = self.repository.list_resolutions(preview_id)
        self._validate_no_blocked_items(preview)
        self._validate_conflicts(preview, resolutions)
        self._validate_fingerprints(preview)

        started_at = self._clock()
        if not self.repository.claim_execution(preview.id, started_at):
            existing_receipt = self.repository.get_receipt(preview_id)
            if existing_receipt is not None:
                return existing_receipt
            raise TransferAlreadyExecutingError("Zotero transfer is already executing")
        receipts: list[TransferItemReceipt] = []
        resolutions_by_conflict = {item.conflict_id: item for item in resolutions}
        for item in preview.items:
            item_resolutions = [
                resolutions_by_conflict[conflict.id]
                for conflict in item.conflicts
                if conflict.id in resolutions_by_conflict
            ]
            if item.action == TransferAction.BLOCKED or any(
                resolution.choice in {ConflictChoice.TARGET, ConflictChoice.SKIP}
                for resolution in item_resolutions
            ):
                receipts.append(
                    TransferItemReceipt(
                        item_id=item.item_id,
                        planned_action=item.action,
                        outcome="skipped",
                        message=item.blocked_reason or "Conflict resolution kept the target.",
                    )
                )
                continue
            try:
                receipts.append(self.executor.apply(preview, item, item_resolutions))
            except Exception as error:  # executor errors become an auditable partial receipt
                receipts.append(
                    TransferItemReceipt(
                        item_id=item.item_id,
                        planned_action=item.action,
                        outcome="failed",
                        message=str(error),
                    )
                )

        receipt = TransferReceipt(
            id=uuid4().hex,
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

    def _validate_fingerprints(self, preview: TransferPreview) -> None:
        current = self.executor.inspect(preview)
        planned_ids = {item.item_id for item in preview.items}
        if set(current) != planned_ids:
            raise StaleTransferPreviewError("Zotero transfer scope changed after preview")
        for item in preview.items:
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
