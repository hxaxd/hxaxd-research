from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class _DocumentModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DocumentStatus(StrEnum):
    EXTRACTING = "extracting"
    READY = "ready"
    FAILED = "failed"
    SUPERSEDED = "superseded"


class BlockKind(StrEnum):
    TITLE = "title"
    HEADING = "heading"
    PARAGRAPH = "paragraph"
    LIST = "list"
    FORMULA = "formula"
    TABLE = "table"
    FIGURE = "figure"
    FOOTNOTE = "footnote"
    REFERENCE = "reference"
    OTHER = "other"


class SemanticRole(StrEnum):
    BACKGROUND = "background"
    QUESTION = "question"
    METHOD = "method"
    EVIDENCE = "evidence"
    RESULT = "result"
    LIMITATION = "limitation"
    CONCLUSION = "conclusion"
    OTHER = "other"


class OcrMode(StrEnum):
    AUTO = "auto"
    FORCE = "force"
    OFF = "off"


class DocumentExtractionRequest(_DocumentModel):
    ocr_mode: OcrMode = OcrMode.AUTO


class DocumentExtractionJobInput(DocumentExtractionRequest):
    attachment_id: str = Field(min_length=1, max_length=200)
    item_id: str = Field(min_length=1, max_length=200)
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    extractor: str = Field(min_length=1, max_length=80)
    extractor_version: str = Field(min_length=1, max_length=80)
    structure_version: str = Field(min_length=1, max_length=80)
    tex_attachment_id: str | None = Field(default=None, min_length=1, max_length=200)
    tex_source_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class DocumentTranslationRequest(_DocumentModel):
    target_language: str = Field(default="zh-CN", min_length=2, max_length=40)

    @field_validator("target_language")
    @classmethod
    def normalize_language(cls, value: str) -> str:
        return value.strip()


class DocumentTranslationJobInput(DocumentTranslationRequest):
    document_id: str = Field(min_length=1, max_length=200)
    structure_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    provider: str = Field(min_length=1, max_length=80)
    model: str = Field(min_length=1, max_length=160)
    prompt_version: str = Field(min_length=1, max_length=80)
    style: Literal["faithful_academic", "natural_academic", "concise"] = (
        "faithful_academic"
    )
    batching: Literal["whole_with_fallback", "whole_only", "chapter"] = (
        "whole_with_fallback"
    )
    retranslate_scope: Literal["changed", "document"] = "changed"
    previous_translation_job_id: str | None = Field(
        default=None, min_length=1, max_length=200
    )
    glossary: list[TranslationGlossaryTerm] = Field(default_factory=list, max_length=500)


class TranslationGlossaryTerm(_DocumentModel):
    source_term: str = Field(min_length=1, max_length=300)
    translated_term: str = Field(min_length=1, max_length=300)


class Document(_DocumentModel):
    id: str
    item_id: str
    source_attachment_id: str
    source_sha256: str
    extractor: str
    extractor_version: str
    structure_version: str
    status: DocumentStatus
    language: str | None
    page_count: int | None
    block_count: int
    structure_hash: str | None
    created_by_job_id: str | None
    created_at: datetime
    completed_at: datetime | None


class ExtractedBlock(_DocumentModel):
    kind: BlockKind
    semantic_role: SemanticRole | None = None
    source_text: str
    page_start: int | None = Field(default=None, ge=1)
    page_end: int | None = Field(default=None, ge=1)
    anchor: dict[str, Any] = Field(default_factory=dict)
    section_path: list[str] = Field(default_factory=list)


class ExtractedDocument(_DocumentModel):
    language: str | None = None
    page_count: int = Field(ge=1)
    blocks: list[ExtractedBlock]
    diagnostics: dict[str, Any] = Field(default_factory=dict)


class BlockTranslation(_DocumentModel):
    id: str
    block_id: str
    target_language: str
    translated_text: str
    source_sha256: str
    provider: str
    model: str
    prompt_version: str
    batch_id: str
    validation_status: str
    created_by_job_id: str | None
    created_at: datetime


class DocumentBlock(_DocumentModel):
    id: str
    document_id: str
    parent_id: str | None
    ordinal: int
    kind: BlockKind
    semantic_role: SemanticRole | None
    source_text: str
    source_sha256: str
    page_start: int | None
    page_end: int | None
    anchor: dict[str, Any]
    section_path: list[str]
    created_at: datetime


class DocumentBlockView(DocumentBlock):
    translation: BlockTranslation | None = None


class DocumentBlocksPage(_DocumentModel):
    document_id: str
    offset: int
    limit: int
    total: int
    items: list[DocumentBlockView]


class TranslationInputBlock(_DocumentModel):
    id: str
    kind: BlockKind
    source_text: str
    section_path: list[str]
    page: int | None


class TranslationOutputItem(_DocumentModel):
    id: str
    translated_text: str = Field(min_length=1)
    semantic_role: SemanticRole


class GlossaryOutputItem(_DocumentModel):
    source_term: str = Field(min_length=1, max_length=300)
    translated_term: str = Field(min_length=1, max_length=300)
    note: str | None = Field(default=None, max_length=1000)


class DocumentTranslationOutput(_DocumentModel):
    translations: list[TranslationOutputItem]
    glossary: list[GlossaryOutputItem] = Field(default_factory=list)
    detected_source_language: str | None = Field(default=None, max_length=40)
