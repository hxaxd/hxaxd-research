from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator

from app.catalog.models import BibliographicItemPatch
from app.integrations.zotero.models import ConflictResolution
from app.operations.models import AttachmentDownloadRequest
from app.screening.models import ProjectInsightsPatch


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ChangeSetKind(StrEnum):
    METADATA_PATCH = "metadata_patch"
    RESOURCE_ACQUISITION = "resource_acquisition"
    PROJECT_INSIGHTS = "project_insights"
    ZOTERO_CONFLICT_RESOLUTION = "zotero_conflict_resolution"


class ChangeSetStatus(StrEnum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    PARTIALLY_APPLIED = "partially_applied"
    APPLIED = "applied"
    REJECTED = "rejected"
    STALE = "stale"
    FAILED = "failed"


class ChangeItemStatus(StrEnum):
    PROPOSED = "proposed"
    APPROVED = "approved"
    REJECTED = "rejected"
    APPLIED = "applied"
    STALE = "stale"
    FAILED = "failed"


class EvidenceReference(_Model):
    source: str = Field(min_length=1, max_length=120)
    url: HttpUrl | None = None
    locator: str | None = Field(default=None, max_length=300)
    quote: str | None = Field(default=None, max_length=4000)
    metadata: dict[str, Any] = Field(default_factory=dict)


class _ItemCreate(_Model):
    evidence: list[EvidenceReference] = Field(default_factory=list, max_length=50)
    rationale: str | None = Field(default=None, max_length=4000)


class MetadataPatchPayload(_Model):
    patch: BibliographicItemPatch


class MetadataChangeItemCreate(_ItemCreate):
    operation: Literal["metadata.patch"]
    target_type: Literal["bibliographic_item"] = "bibliographic_item"
    target_id: str = Field(min_length=1)
    base_revision: int = Field(ge=1)
    payload: MetadataPatchPayload


class ResourceAcquisitionPayload(_Model):
    request: AttachmentDownloadRequest


class ResourceChangeItemCreate(_ItemCreate):
    operation: Literal["resource.acquire"]
    target_type: Literal["bibliographic_item"] = "bibliographic_item"
    target_id: str = Field(min_length=1)
    base_revision: int = Field(ge=1)
    payload: ResourceAcquisitionPayload


class ProjectInsightsPayload(_Model):
    project_id: str = Field(min_length=1)
    work_id: str = Field(min_length=1)
    base_updated_at: datetime
    patch: ProjectInsightsPatch


class ProjectInsightsChangeItemCreate(_ItemCreate):
    operation: Literal["project.insight.patch"]
    target_type: Literal["project_work"] = "project_work"
    target_id: str = Field(min_length=1)
    base_revision: str = Field(min_length=1)
    payload: ProjectInsightsPayload

    @model_validator(mode="after")
    def revision_matches_payload(self) -> ProjectInsightsChangeItemCreate:
        expected = self.payload.base_updated_at.isoformat().replace("+00:00", "Z")
        if self.base_revision != expected:
            raise ValueError("project insight base revision does not match base_updated_at")
        return self


class ZoteroConflictPayload(_Model):
    preview_id: str = Field(min_length=1)
    expected_preview_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    resolution: ConflictResolution


class ZoteroConflictChangeItemCreate(_ItemCreate):
    operation: Literal["zotero.conflict.resolve"]
    target_type: Literal["zotero_conflict"] = "zotero_conflict"
    target_id: str = Field(min_length=1)
    base_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: ZoteroConflictPayload

    @model_validator(mode="after")
    def revision_matches_preview(self) -> ZoteroConflictChangeItemCreate:
        if self.base_revision != self.payload.expected_preview_hash:
            raise ValueError("Zotero base revision does not match preview hash")
        if self.target_id != self.payload.resolution.conflict_id:
            raise ValueError("Zotero target does not match conflict resolution")
        return self


ChangeItemCreate = Annotated[
    MetadataChangeItemCreate
    | ResourceChangeItemCreate
    | ProjectInsightsChangeItemCreate
    | ZoteroConflictChangeItemCreate,
    Field(discriminator="operation"),
]

_OPERATION_KIND = {
    "metadata.patch": ChangeSetKind.METADATA_PATCH,
    "resource.acquire": ChangeSetKind.RESOURCE_ACQUISITION,
    "project.insight.patch": ChangeSetKind.PROJECT_INSIGHTS,
    "zotero.conflict.resolve": ChangeSetKind.ZOTERO_CONFLICT_RESOLUTION,
}


class ChangeSetCreate(_Model):
    kind: ChangeSetKind
    summary: str = Field(min_length=1, max_length=2000)
    project_id: str | None = None
    item_id: str | None = None
    source_version: str | None = Field(default=None, max_length=200)
    items: list[ChangeItemCreate] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def items_match_kind_and_scope(self) -> ChangeSetCreate:
        if any(_OPERATION_KIND[item.operation] is not self.kind for item in self.items):
            raise ValueError("change item operation does not match change set kind")
        if self.item_id is not None and any(
            item.target_type == "bibliographic_item" and item.target_id != self.item_id
            for item in self.items
        ):
            raise ValueError("change item target is outside the declared item scope")
        if self.project_id is not None and any(
            isinstance(item, ProjectInsightsChangeItemCreate)
            and item.payload.project_id != self.project_id
            for item in self.items
        ):
            raise ValueError("project insight target is outside the declared project scope")
        return self


class ChangeReviewDecision(_Model):
    change_item_id: str = Field(min_length=1)
    decision: Literal["approve", "reject"]


class ChangeSetReviewRequest(_Model):
    expected_content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    decisions: list[ChangeReviewDecision] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def decisions_are_unique(self) -> ChangeSetReviewRequest:
        ids = [decision.change_item_id for decision in self.decisions]
        if len(ids) != len(set(ids)):
            raise ValueError("change review contains duplicate item decisions")
        return self


class ChangeSetApplyRequest(_Model):
    expected_content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class ChangeItemView(_Model):
    id: str
    position: int
    operation: str
    target_type: str
    target_id: str
    base_revision: str | None
    status: ChangeItemStatus
    payload: dict[str, Any]
    evidence: list[EvidenceReference]
    result: dict[str, Any] | None
    rationale: str | None
    error_code: str | None
    error_message: str | None
    created_at: datetime
    reviewed_at: datetime | None
    applied_at: datetime | None


class ChangeSetView(_Model):
    id: str
    kind: ChangeSetKind
    status: ChangeSetStatus
    agent_run_id: str | None
    project_id: str | None
    item_id: str | None
    source_version: str | None
    content_hash: str
    summary: str
    items: list[ChangeItemView]
    created_at: datetime
    submitted_at: datetime | None
    reviewed_at: datetime | None
    reviewed_by: str | None
    applied_at: datetime | None


class ChangeSetList(_Model):
    items: list[ChangeSetView]
    total: int
    limit: int
    offset: int
