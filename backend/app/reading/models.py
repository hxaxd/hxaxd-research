from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class _ReadingModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AnnotationKind(StrEnum):
    HIGHLIGHT = "highlight"
    EXCERPT = "excerpt"
    QUESTION = "question"
    CLAIM = "claim"
    METHOD = "method"
    RESULT = "result"
    LIMITATION = "limitation"
    BIBLIOGRAPHIC_NOTE = "bibliographic_note"


class AnnotationAnchorStatus(StrEnum):
    VALID = "valid"
    STALE = "stale"
    UNRESOLVED = "unresolved"


class AnnotationCreate(_ReadingModel):
    attachment_id: str | None = Field(default=None, max_length=200)
    block_id: str | None = Field(default=None, max_length=200)
    kind: AnnotationKind = AnnotationKind.HIGHLIGHT
    body: str = Field(default="", max_length=20_000)
    quoted_text: str | None = Field(default=None, max_length=50_000)
    page_number: int | None = Field(default=None, ge=1)
    anchor: dict[str, Any] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list, max_length=30)

    @field_validator("body")
    @classmethod
    def normalize_body(cls, value: str) -> str:
        return value.strip()

    @field_validator("quoted_text")
    @classmethod
    def normalize_quote(cls, value: str | None) -> str | None:
        stripped = value.strip() if value else ""
        return stripped or None

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, values: list[str]) -> list[str]:
        normalized = [value.strip().casefold() for value in values if value.strip()]
        if len(normalized) != len(set(normalized)):
            raise ValueError("批注标签不能重复")
        if any(len(value) > 80 for value in normalized):
            raise ValueError("批注标签过长")
        return normalized

    @model_validator(mode="after")
    def require_content(self) -> AnnotationCreate:
        if not self.body and not self.quoted_text and self.block_id is None:
            raise ValueError("批注必须包含正文、引文或阅读块")
        return self


class AnnotationUpdate(_ReadingModel):
    expected_updated_at: datetime
    kind: AnnotationKind
    body: str = Field(default="", max_length=20_000)
    tags: list[str] = Field(default_factory=list, max_length=30)

    @field_validator("body")
    @classmethod
    def normalize_body(cls, value: str) -> str:
        return value.strip()

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, values: list[str]) -> list[str]:
        normalized = [value.strip().casefold() for value in values if value.strip()]
        if len(normalized) != len(set(normalized)):
            raise ValueError("批注标签不能重复")
        if any(len(value) > 80 for value in normalized):
            raise ValueError("批注标签过长")
        return normalized


class Annotation(_ReadingModel):
    id: str
    project_id: str | None
    item_id: str
    attachment_id: str | None
    block_id: str | None
    kind: AnnotationKind
    body: str
    quoted_text: str | None
    source_sha256: str | None
    page_number: int | None
    anchor: dict[str, Any]
    anchor_status: AnnotationAnchorStatus
    tags: list[str]
    created_at: datetime
    updated_at: datetime


class ReadingBookmarkCreate(_ReadingModel):
    block_id: str | None = Field(default=None, max_length=200)
    page_number: int | None = Field(default=None, ge=1)
    label: str = Field(min_length=1, max_length=300)

    @field_validator("label")
    @classmethod
    def normalize_label(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def require_anchor(self) -> ReadingBookmarkCreate:
        if self.block_id is None and self.page_number is None:
            raise ValueError("书签必须指向阅读块或页码")
        return self


class ReadingBookmark(ReadingBookmarkCreate):
    id: str
    created_at: datetime


class ReadingStateUpdate(_ReadingModel):
    attachment_id: str | None = Field(default=None, max_length=200)
    block_id: str | None = Field(default=None, max_length=200)
    page_number: int | None = Field(default=None, ge=1)
    progress: float = Field(default=0, ge=0, le=1)


class ReadingState(ReadingStateUpdate):
    project_id: str
    item_id: str
    bookmarks: list[ReadingBookmark] = Field(default_factory=list)
    updated_at: datetime | None = None

