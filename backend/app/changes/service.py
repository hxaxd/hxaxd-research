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
from app.jobs import JobNotFoundError, JobStatus
from app.jobs.public import project_public_job
from app.operations import OperationService
from app.screening import ScreeningCommands, ScreeningQueries
from app.screening.domain import ScreeningConflictError, ScreeningNotFoundError

from .domain import ChangeSetConflictError
from .models import (
    ChangeItemStatus,
    ChangeItemView,
    ChangeSetApplyRequest,
    ChangeSetCreate,
    ChangeSetKind,
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
        return self._reconcile_resource_change_set(change_set_id)

    def list(
        self,
        *,
        status: ChangeSetStatus | None = None,
        project_id: str | None = None,
        item_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> ChangeSetList:
        self.reconcile_pending()
        return self.repository.list(
            status=status,
            project_id=project_id,
            item_id=item_id,
            limit=limit,
            offset=offset,
        )

    def reconcile_pending(self) -> int:
        change_set_ids = self.repository.pending_resource_ids()
        for change_set_id in change_set_ids:
            self._reconcile_resource_change_set(change_set_id)
        return len(change_set_ids)

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
        change_set = self._reconcile_resource_change_set(change_set_id)
        if change_set.content_hash != request.expected_content_hash:
            raise ChangeSetConflictError("change set content hash changed")
        if change_set.status is ChangeSetStatus.APPLIED:
            return change_set
        if change_set.status is ChangeSetStatus.STALE:
            raise ChangeSetConflictError("stale change set can no longer be applied")
        approved = [item for item in change_set.items if item.status is ChangeItemStatus.APPROVED]
        if not approved:
            raise ChangeSetConflictError("change set has no approved changes to apply")

        self.repository.reject_unselected(change_set_id, reviewed_by=actor_id)
        if change_set.kind is not ChangeSetKind.RESOURCE_ACQUISITION:
            return self._apply_atomic_database_changes(
                change_set,
                approved,
                actor_id=actor_id,
            )

        for item in approved:
            try:
                result = self._apply_item(change_set, item, actor_id=actor_id)
                self.repository.mark_item(
                    item.id,
                    ChangeItemStatus.APPROVED,
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

        return self._reconcile_resource_change_set(change_set_id)

    def _reconcile_resource_change_set(self, change_set_id: str) -> ChangeSetView:
        current = self.repository.get(change_set_id)
        if current.kind is not ChangeSetKind.RESOURCE_ACQUISITION:
            return current

        for item in current.items:
            if item.status in {
                ChangeItemStatus.APPLIED,
                ChangeItemStatus.REJECTED,
                ChangeItemStatus.STALE,
            }:
                continue
            result = item.result or {}
            job_id = result.get("job_id")
            if not isinstance(job_id, str) or not job_id:
                continue
            try:
                job = self.operations.job_repository.get(job_id)
            except JobNotFoundError:
                self.repository.mark_item(
                    item.id,
                    ChangeItemStatus.FAILED,
                    result={**result, "job_status": "missing"},
                    error_code="resource_job_missing",
                    error_message="资源获取任务不存在",
                )
                continue

            public = project_public_job(job)
            if (
                item.status is ChangeItemStatus.FAILED
                and result.get("job_status") == job.status.value
            ):
                continue
            if (
                item.status is ChangeItemStatus.APPROVED
                and result.get("job_status") == job.status.value
            ):
                continue
            job_result = {
                **result,
                "job_status": job.status.value,
                "job_result": public.result,
            }
            if job.status is JobStatus.SUCCEEDED:
                self.repository.mark_item(
                    item.id,
                    ChangeItemStatus.APPLIED,
                    result=job_result,
                )
            elif job.status in {JobStatus.FAILED, JobStatus.CANCELED}:
                self.repository.mark_item(
                    item.id,
                    ChangeItemStatus.FAILED,
                    result=job_result,
                    error_code=(
                        job.error_code
                        if job.status is JobStatus.FAILED and job.error_code
                        else f"resource_job_{job.status.value}"
                    ),
                    error_message=(
                        public.error_message
                        or (
                            "资源获取任务已取消"
                            if job.status is JobStatus.CANCELED
                            else "资源获取任务失败"
                        )
                    ),
                )
            else:
                self.repository.mark_item(
                    item.id,
                    ChangeItemStatus.APPROVED,
                    result=job_result,
                )

        current = self.repository.get(change_set_id)
        attempted = [
            item
            for item in current.items
            if item.status
            in {ChangeItemStatus.APPLIED, ChangeItemStatus.STALE, ChangeItemStatus.FAILED}
        ]
        applied = [item for item in attempted if item.status is ChangeItemStatus.APPLIED]
        pending = [
            item
            for item in current.items
            if item.status in {ChangeItemStatus.PROPOSED, ChangeItemStatus.APPROVED}
        ]
        if pending:
            final_status = ChangeSetStatus.SUBMITTED
        elif attempted and len(applied) == len(attempted):
            final_status = ChangeSetStatus.APPLIED
        elif applied:
            final_status = ChangeSetStatus.PARTIALLY_APPLIED
        elif attempted and all(item.status is ChangeItemStatus.STALE for item in attempted):
            final_status = ChangeSetStatus.STALE
        elif attempted:
            final_status = ChangeSetStatus.FAILED
        else:
            final_status = current.status
        if current.status is final_status:
            return current
        return self.repository.finish_apply(change_set_id, final_status)

    def _apply_atomic_database_changes(
        self,
        change_set: ChangeSetView,
        approved: list[ChangeItemView],
        *,
        actor_id: str,
    ) -> ChangeSetView:
        """Apply a user's selected database changes in one shared transaction."""

        try:
            with self.repository.database.transaction():
                for item in approved:
                    result = self._apply_item(change_set, item, actor_id=actor_id)
                    self.repository.mark_item(
                        item.id,
                        ChangeItemStatus.APPLIED,
                        result=result,
                    )
                return self.repository.finish_apply(
                    change_set.id,
                    ChangeSetStatus.APPLIED,
                )
        except _STALE_ERRORS as error:
            return self._finish_atomic_failure(
                change_set.id,
                approved,
                item_status=ChangeItemStatus.STALE,
                set_status=ChangeSetStatus.STALE,
                error_code="stale_target",
                error_message=(f"所选变更已全部回滚；至少一个目标版本已变化：{error}"),
            )
        except Exception as error:
            return self._finish_atomic_failure(
                change_set.id,
                approved,
                item_status=ChangeItemStatus.FAILED,
                set_status=ChangeSetStatus.FAILED,
                error_code="atomic_apply_aborted",
                error_message=f"所选变更已全部回滚：{error}",
            )

    def _finish_atomic_failure(
        self,
        change_set_id: str,
        approved: list[ChangeItemView],
        *,
        item_status: ChangeItemStatus,
        set_status: ChangeSetStatus,
        error_code: str,
        error_message: str,
    ) -> ChangeSetView:
        with self.repository.database.transaction():
            for item in approved:
                self.repository.mark_item(
                    item.id,
                    item_status,
                    error_code=error_code,
                    error_message=error_message,
                )
            return self.repository.finish_apply(change_set_id, set_status)

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
                    conflict.id for plan_item in preview.items for conflict in plan_item.conflicts
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
            if change_set.project_id is None:
                raise ChangeSetConflictError("resource acquisition has no project scope")
            current = self.catalog.get_item(item.target_id)
            if current.revision != int(item.base_revision or "0"):
                raise CatalogConflictError("resource proposal item revision is stale")
            job = self.operations.download_attachment(
                item.target_id,
                payload.request,
                project_id=change_set.project_id,
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
