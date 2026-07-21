from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ZoteroModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreatorKind(StrEnum):
    PERSON = "person"
    ORGANIZATION = "organization"


class BibliographicCreator(ZoteroModel):
    role: str = "author"
    kind: CreatorKind
    given: str | None = None
    family: str | None = None
    literal: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def organization_requires_literal_name(self) -> BibliographicCreator:
        if self.kind == CreatorKind.ORGANIZATION and not (self.literal or "").strip():
            raise ValueError("organization creator requires a literal name")
        return self


class BibliographicDate(ZoteroModel):
    literal: str
    year: int | None = Field(default=None, ge=0, le=9999)
    month: int | None = Field(default=None, ge=1, le=12)
    day: int | None = Field(default=None, ge=1, le=31)


class BibliographicIdentifier(ZoteroModel):
    scheme: str
    value: str
    normalized_value: str


class BibliographicTag(ZoteroModel):
    name: str
    type: int | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class BibliographicDraft(ZoteroModel):
    """Provider-neutral bibliographic data plus a lossless provider envelope."""

    external_key: str | None = None
    external_version: int | None = Field(default=None, ge=0)
    item_type: str
    title: str
    short_title: str | None = None
    creators: list[BibliographicCreator] = Field(default_factory=list)
    abstract: str | None = None
    issued: BibliographicDate | None = None
    container_title: str | None = None
    container_title_field: str | None = None
    publisher: str | None = None
    place: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    edition: str | None = None
    language: str | None = None
    rights: str | None = None
    identifiers: list[BibliographicIdentifier] = Field(default_factory=list)
    url: str | None = None
    tags: list[BibliographicTag] = Field(default_factory=list)
    collections: list[str] = Field(default_factory=list)
    relations: dict[str, Any] = Field(default_factory=dict)
    extra: str | None = None
    unknown_fields: dict[str, Any] = Field(default_factory=dict)
    raw: dict[str, Any] = Field(default_factory=dict)


class ZoteroLibraryKind(StrEnum):
    USER = "users"
    GROUP = "groups"


class ZoteroLibraryRef(ZoteroModel):
    kind: ZoteroLibraryKind
    id: str = Field(min_length=1)

    @property
    def path(self) -> str:
        return f"/{self.kind.value}/{self.id}"


class TransferDirection(StrEnum):
    IMPORT = "import"
    EXPORT = "export"


class TransferAction(StrEnum):
    NEW = "new"
    UPDATE = "update"
    UNCHANGED = "unchanged"
    CONFLICT = "conflict"
    BLOCKED = "blocked"


class TransferStatus(StrEnum):
    PREVIEW_READY = "preview_ready"
    APPLYING = "applying"
    SUCCEEDED = "succeeded"
    PARTIAL = "partial"
    FAILED = "failed"


class ConflictKind(StrEnum):
    UNLINKED_TARGET = "unlinked_target"
    SOURCE_AND_TARGET_CHANGED = "source_and_target_changed"
    TARGET_CHANGED = "target_changed"
    INCONSISTENT_BASELINE = "inconsistent_baseline"


class ConflictChoice(StrEnum):
    SOURCE = "source"
    TARGET = "target"
    MANUAL = "manual"
    SKIP = "skip"


class TransferFingerprint(ZoteroModel):
    key: str | None = None
    version: int | None = Field(default=None, ge=0)
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class TransferAttachmentSnapshot(ZoteroModel):
    """Stable, non-path attachment identity used in previews and stale checks."""

    ref: str = Field(min_length=1)
    filename: str = Field(min_length=1)
    media_type: str = "application/octet-stream"
    size: int | None = Field(default=None, ge=0)
    checksum: str | None = None
    checksum_algorithm: Literal["md5", "sha256"] | None = None
    local_attachment_id: str | None = None
    external_key: str | None = None
    external_version: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def checksum_has_an_algorithm(self) -> TransferAttachmentSnapshot:
        if (self.checksum is None) != (self.checksum_algorithm is None):
            raise ValueError("attachment checksum and algorithm must be supplied together")
        return self


class SyncBaseline(ZoteroModel):
    source_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    target_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_version: int | None = Field(default=None, ge=0)
    target_version: int | None = Field(default=None, ge=0)


class TransferCandidate(ZoteroModel):
    item_id: str = Field(min_length=1)
    source: BibliographicDraft
    target: BibliographicDraft | None = None
    source_attachments: list[TransferAttachmentSnapshot] = Field(default_factory=list)
    target_attachments: list[TransferAttachmentSnapshot] = Field(default_factory=list)
    baseline: SyncBaseline | None = None
    blocked_reason: str | None = None


class FieldDifference(ZoteroModel):
    field: str
    source: Any = None
    target: Any = None


class TransferConflict(ZoteroModel):
    id: str
    item_id: str
    kind: ConflictKind
    message: str
    fields: list[str] = Field(default_factory=list)


class TransferAttachmentPlan(ZoteroModel):
    ref: str
    action: TransferAction
    source: TransferAttachmentSnapshot
    target: TransferAttachmentSnapshot | None = None
    blocked_reason: str | None = None


class ConflictResolution(ZoteroModel):
    conflict_id: str
    choice: ConflictChoice
    manual_changes: dict[str, Any] | None = None
    resolved_at: datetime | None = None

    @model_validator(mode="after")
    def manual_choice_requires_changes(self) -> ConflictResolution:
        if self.choice == ConflictChoice.MANUAL and not self.manual_changes:
            raise ValueError("manual conflict resolution requires manual_changes")
        if self.choice != ConflictChoice.MANUAL and self.manual_changes is not None:
            raise ValueError("manual_changes is only valid for manual resolution")
        return self


class TransferPlanItem(ZoteroModel):
    item_id: str
    action: TransferAction
    source: BibliographicDraft
    target: BibliographicDraft | None
    source_fingerprint: TransferFingerprint
    target_fingerprint: TransferFingerprint | None
    differences: list[FieldDifference] = Field(default_factory=list)
    attachments: list[TransferAttachmentPlan] = Field(default_factory=list)
    conflicts: list[TransferConflict] = Field(default_factory=list)
    blocked_reason: str | None = None


class TransferSummary(ZoteroModel):
    total: int
    new: int = 0
    update: int = 0
    unchanged: int = 0
    conflict: int = 0
    blocked: int = 0


class TransferPreviewRequest(ZoteroModel):
    direction: TransferDirection
    library: ZoteroLibraryRef
    project_id: str = Field(min_length=1)
    ttl_seconds: int = Field(default=900, ge=30, le=86_400)


class TransferPlanRequest(TransferPreviewRequest):
    items: list[TransferCandidate] = Field(default_factory=list, max_length=5_000)

    @model_validator(mode="after")
    def item_ids_are_unique(self) -> TransferPlanRequest:
        item_ids = [item.item_id for item in self.items]
        if len(item_ids) != len(set(item_ids)):
            raise ValueError("transfer item IDs must be unique")
        return self


class TransferPreview(ZoteroModel):
    id: str
    direction: TransferDirection
    library: ZoteroLibraryRef
    project_id: str
    status: Literal[TransferStatus.PREVIEW_READY] = TransferStatus.PREVIEW_READY
    created_at: datetime
    expires_at: datetime
    items: list[TransferPlanItem]
    summary: TransferSummary
    preview_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class PublicTransferPlanItem(ZoteroModel):
    item_id: str
    action: TransferAction
    differences: list[FieldDifference] = Field(default_factory=list)
    conflicts: list[TransferConflict] = Field(default_factory=list)
    blocked_reason: str | None = None


class PublicTransferPreview(ZoteroModel):
    id: str
    direction: TransferDirection
    created_at: datetime
    expires_at: datetime
    items: list[PublicTransferPlanItem]
    summary: TransferSummary
    preview_hash: str = Field(pattern=r"^[0-9a-f]{64}$")

    @classmethod
    def from_internal(cls, preview: TransferPreview) -> PublicTransferPreview:
        return cls(
            id=preview.id,
            direction=preview.direction,
            created_at=preview.created_at,
            expires_at=preview.expires_at,
            items=[
                PublicTransferPlanItem(
                    item_id=item.item_id,
                    action=item.action,
                    differences=item.differences,
                    conflicts=item.conflicts,
                    blocked_reason=item.blocked_reason,
                )
                for item in preview.items
            ],
            summary=preview.summary,
            preview_hash=preview.preview_hash,
        )


class TransferExecuteRequest(ZoteroModel):
    confirmed: bool
    expected_preview_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class TransferItemReceipt(ZoteroModel):
    item_id: str
    planned_action: TransferAction
    outcome: Literal["created", "updated", "unchanged", "skipped", "failed"]
    external_key: str | None = None
    external_version: int | None = Field(default=None, ge=0)
    message: str | None = None


class TransferReceipt(ZoteroModel):
    id: str
    preview_id: str
    preview_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    status: TransferStatus
    started_at: datetime
    finished_at: datetime
    items: list[TransferItemReceipt]


class ZoteroEndpointStatus(ZoteroModel):
    available: bool
    read_only: bool
    message: str


class ZoteroIntegrationStatus(ZoteroModel):
    local: ZoteroEndpointStatus
    web: ZoteroEndpointStatus
    import_available: bool
    export_available: bool


class ZoteroBinding(ZoteroModel):
    id: str
    library: ZoteroLibraryRef
    entity_type: Literal["bibliographic_item", "attachment"]
    entity_id: str
    external_key: str
    external_version: int | None = Field(default=None, ge=0)
    local_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    remote_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    project_id: str | None = None
    parent_item_id: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class ZoteroAttachmentAuthorization(ZoteroModel):
    exists: bool = False
    url: str | None = None
    content_type: str | None = None
    prefix: str | None = None
    suffix: str | None = None
    upload_key: str | None = None

    @model_validator(mode="after")
    def authorized_upload_is_complete(self) -> ZoteroAttachmentAuthorization:
        if not self.exists and not all(
            (
                self.url,
                self.content_type,
                self.prefix is not None,
                self.suffix is not None,
                self.upload_key,
            )
        ):
            raise ValueError("upload authorization is incomplete")
        return self


class ZoteroAttachmentUploadResult(ZoteroModel):
    item_key: str
    filename: str
    md5: str = Field(pattern=r"^[0-9a-f]{32}$")
    size: int = Field(ge=0)
    existed: bool
    library_version: int | None = Field(default=None, ge=0)
