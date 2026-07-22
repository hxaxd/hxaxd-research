from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class AttachmentType(StrEnum):
    FULLTEXT = "fulltext"
    SOURCE_ARCHIVE = "source_archive"
    SUPPLEMENT = "supplement"
    OTHER = "other"


class AttachmentFormat(StrEnum):
    PDF = "pdf"
    TEX = "tex"
    OTHER = "other"


class LanguageMode(StrEnum):
    ORIGINAL = "original"
    TRANSLATED = "translated"
    BILINGUAL = "bilingual"


class AttachmentOrigin(StrEnum):
    PUBLISHER = "publisher"
    PREPRINT = "preprint"
    AUTHOR = "author"
    USER = "user"
    GENERATED = "generated"
    LEGACY = "legacy"
    ZOTERO = "zotero"


class Attachment(BaseModel):
    id: str
    item_id: str
    blob_id: str
    attachment_type: AttachmentType
    format: AttachmentFormat
    language_mode: LanguageMode
    origin: AttachmentOrigin
    filename: str
    source_url: str | None
    media_type: str
    sha256: str
    size: int
    storage_key: str
    preferred_for: list[str] = Field(default_factory=list)
    created_at: datetime


class PublicAttachment(BaseModel):
    """Browser projection without storage topology or credential-bearing provenance URLs."""

    id: str
    item_id: str
    attachment_type: AttachmentType
    format: AttachmentFormat
    language_mode: LanguageMode
    origin: AttachmentOrigin
    filename: str
    media_type: str
    sha256: str
    size: int
    preferred_for: list[str] = Field(default_factory=list)
    created_at: datetime

    @classmethod
    def from_internal(cls, attachment: Attachment) -> PublicAttachment:
        return cls.model_validate(
            attachment.model_dump(
                exclude={"blob_id", "source_url", "storage_key"},
            )
        )


class AttachmentPreferenceCommand(BaseModel):
    purpose: str = Field(min_length=1, max_length=80)
    attachment_id: str


class GeneratedAttachment(BaseModel):
    filename: str
    attachment_type: AttachmentType = AttachmentType.FULLTEXT
    format: AttachmentFormat | None = None
    language_mode: LanguageMode
    origin: AttachmentOrigin = AttachmentOrigin.GENERATED
    source_url: str | None = None
    preferred_for: list[str] = Field(default_factory=list)
