from __future__ import annotations

import hashlib
import json

from app.catalog import CatalogCommands, CatalogQueries
from app.catalog.domain import CatalogConflictError, CatalogNotFoundError
from app.integrations.zotero.service import (
    StaleTransferPreviewError,
    TransferNotFoundError,
    ZoteroTransferService,
)
from app.operations import OperationService
from app.screening import ScreeningCommands, ScreeningQueries
from app.screening.domain import ScreeningConflictError, ScreeningNotFoundError

from .domain import ChangeSetConflictError
from .models import (
    ChangeItemStatus,
    ChangeItemView,
    ChangeSetApplyRequest,
    ChangeSetCreate,
    ChangeSetList,
    ChangeSetReviewRequest,
    ChangeSetStatus,
    ChangeSetView,
    MetadataPatchPayload,
    ProjectInsightsPayload,
    ResourceAcquisitionPayload,
    ZoteroConflictPayload,
)
from .repository import ChangeSetRepository

_STALE_ERRORS = (
    CatalogConflictError,
    CatalogNotFoundError,
    ScreeningConflictError,
    ScreeningNotFoundError,
    StaleTransferPreviewError,
    TransferNotFoundError,
)


class ChangeSetService:
    def __init__(
        self,
        repository: ChangeSetRepository,
        catalog: CatalogQueries,
        catalog_commands: CatalogCommands,
        screening: ScreeningQueries,
        screening_commands: ScreeningCommands,
        operations: OperationService,
        zotero: ZoteroTransferService,
    ) -> None:
        self.repository = repository
        self.catalog = catalog
        self.catalog_commands = catalog_commands
        self.screening = screening
        self.screening_commands = screening_commands
        self.operations = operations
        self.zotero = zotero

    def propose(
        self,
        payload: ChangeSetCreate,
        *,
        agent_run_id: str | None = None,
        actor_type: str = "user",
        actor_id: str | None = None,
    ) -> ChangeSetView:
        self._validate_targets(payload)
        canonical = payload.model_dump(mode="json", exclude_unset=True)
        content_hash = hashlib.sha256(
            json.dumps(
                canonical,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        return self.repository.create(
            payload,
            content_hash=content_hash,
            agent_run_id=agent_run_id,
            actor_type=actor_type,
            actor_id=actor_id,
        )

    def get(self, change_set_id: str) -> ChangeSetView:
        return self.repository.get(change_set_id)

    def list(
        self,
        *,
        status: ChangeSetStatus | None = None,
        project_id: str | None = None,
        item_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> ChangeSetList:
        return self.repository.list(
            status=status,
            project_id=project_id,
            item_id=item_id,
            limit=limit,
            offset=offset,
        )

    def review(
        self,
        change_set_id: str,
        request: ChangeSetReviewRequest,
        *,
        reviewed_by: str = "local-user",
    ) -> ChangeSetView:
        return self.repository.review(
            change_set_id,
            expected_content_hash=request.expected_content_hash,
            decisions=request.decisions,
            reviewed_by=reviewed_by,
        )

    def apply(
        self,
        change_set_id: str,
        request: ChangeSetApplyRequest,
        *,
        actor_id: str = "local-user",
    ) -> ChangeSetView:
        change_set = self.repository.get(change_set_id)
        if change_set.content_hash != request.expected_content_hash:
            raise ChangeSetConflictError("change set content hash changed")
        if change_set.status is ChangeSetStatus.APPLIED:
            return change_set
        approved = [
            item for item in change_set.items if item.status is ChangeItemStatus.APPROVED
        ]
        if not approved:
            raise ChangeSetConflictError("change set has no approved changes to apply")

        for item in approved:
            try:
                result = self._apply_item(change_set, item, actor_id=actor_id)
                self.repository.mark_item(
                    item.id,
                    ChangeItemStatus.APPLIED,
                    result=result,
                )
            except _STALE_ERRORS as error:
                self.repository.mark_item(
                    item.id,
                    ChangeItemStatus.STALE,
                    error_code="stale_target",
                    error_message=str(error),
                )
            except Exception as error:
                self.repository.mark_item(
                    item.id,
                    ChangeItemStatus.FAILED,
                    error_code="apply_failed",
                    error_message=str(error),
                )

        current = self.repository.get(change_set_id)
        attempted = [
            item
            for item in current.items
            if item.status
            in {ChangeItemStatus.APPLIED, ChangeItemStatus.STALE, ChangeItemStatus.FAILED}
        ]
        applied = [item for item in attempted if item.status is ChangeItemStatus.APPLIED]
        if attempted and len(applied) == len(attempted):
            final_status = ChangeSetStatus.APPLIED
        elif applied:
            final_status = ChangeSetStatus.PARTIALLY_APPLIED
        elif attempted and all(item.status is ChangeItemStatus.STALE for item in attempted):
            final_status = ChangeSetStatus.STALE
        else:
            final_status = ChangeSetStatus.FAILED
        return self.repository.finish_apply(change_set_id, final_status)

    def _validate_targets(self, payload: ChangeSetCreate) -> None:
        if payload.project_id is not None:
            self.screening.get_project(payload.project_id)
        for item in payload.items:
            if item.operation in {"metadata.patch", "resource.acquire"}:
                current = self.catalog.get_item(item.target_id)
                if payload.project_id is not None:
                    self.catalog.get_project_item(payload.project_id, item.target_id)
                if current.revision != item.base_revision:
                    raise ChangeSetConflictError(
                        f"item {item.target_id} changed before the proposal was submitted"
                    )
            elif item.operation == "project.insight.patch":
                view = self.screening.get_project_work(
                    item.payload.project_id,
                    item.payload.work_id,
                )
                expected = item.payload.base_updated_at.isoformat().replace("+00:00", "Z")
                observed = view.updated_at.isoformat().replace("+00:00", "Z")
                if item.target_id != view.id or expected != observed:
                    raise ChangeSetConflictError(
                        "project work changed before the proposal was submitted"
                    )
            elif item.operation == "zotero.conflict.resolve":
                preview = self.zotero.get_preview(item.payload.preview_id)
                if preview.preview_hash != item.payload.expected_preview_hash:
                    raise ChangeSetConflictError(
                        "Zotero preview changed before the proposal was submitted"
                    )
                conflict_ids = {
                    conflict.id
                    for plan_item in preview.items
                    for conflict in plan_item.conflicts
                }
                if item.target_id not in conflict_ids:
                    raise ChangeSetConflictError("Zotero conflict is not in the preview")

    def _apply_item(
        self,
        change_set: ChangeSetView,
        item: ChangeItemView,
        *,
        actor_id: str,
    ) -> dict:
        if item.operation == "metadata.patch":
            payload = MetadataPatchPayload.model_validate(item.payload)
            result = self.catalog_commands.apply_metadata_patch(
                item.target_id,
                int(item.base_revision or "0"),
                payload.patch,
                actor_type="user",
                actor_id=actor_id,
                correlation_id=item.id,
                change_set_id=change_set.id,
                revision_id=item.id,
                evidence=[entry.model_dump(mode="json") for entry in item.evidence],
            )
            return {"item_id": result.id, "revision": result.revision}
        if item.operation == "resource.acquire":
            payload = ResourceAcquisitionPayload.model_validate(item.payload)
            current = self.catalog.get_item(item.target_id)
            if current.revision != int(item.base_revision or "0"):
                raise CatalogConflictError("resource proposal item revision is stale")
            job = self.operations.download_attachment(
                item.target_id,
                payload.request,
                idempotency_key=f"change-item:{item.id}",
            )
            return {"job_id": job.id, "job_status": job.status.value}
        if item.operation == "project.insight.patch":
            payload = ProjectInsightsPayload.model_validate(item.payload)
            result = self.screening_commands.apply_project_insights(
                payload.project_id,
                payload.work_id,
                item.base_revision or "",
                payload.patch,
                actor_type="user",
                actor_id=actor_id,
                correlation_id=item.id,
            )
            return {"project_work_id": result.id, "updated_at": result.updated_at.isoformat()}
        if item.operation == "zotero.conflict.resolve":
            payload = ZoteroConflictPayload.model_validate(item.payload)
            preview = self.zotero.get_preview(payload.preview_id)
            if preview.preview_hash != payload.expected_preview_hash:
                raise StaleTransferPreviewError("Zotero preview hash changed")
            result = self.zotero.resolve_conflict(payload.preview_id, payload.resolution)
            return {
                "preview_id": payload.preview_id,
                "conflict_id": result.conflict_id,
                "choice": result.choice.value,
            }
        raise ChangeSetConflictError(f"unsupported change operation: {item.operation}")
