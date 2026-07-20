from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, Field, HttpUrl, StringConstraints, field_validator, model_validator

from app.modules.resources.models import Resource

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class PaperStatus(StrEnum):
    DISCOVERED = "discovered"
    INCLUDED = "included"
    EXCLUDED = "excluded"
    ARCHIVED = "archived"


class PublicationState(StrEnum):
    PREPRINT = "preprint"
    ACCEPTED = "accepted"
    PUBLISHED = "published"
    UNKNOWN = "unknown"


class PaperRole(StrEnum):
    SURVEY = "综述"
    FOUNDATIONAL = "奠基"
    METHOD = "方法"
    SYSTEM = "系统"
    BENCHMARK = "Benchmark"
    COUNTEREXAMPLE = "反例"
    ADJACENT = "相邻工作"


class PaperIdentifierInput(BaseModel):
    scheme: NonEmptyText = Field(description="标识符类型，如 doi、arxiv、openreview")
    value: NonEmptyText


class PaperIdentifier(PaperIdentifierInput):
    id: str
    normalized_value: str
    is_primary: bool
    source: str | None = None


class PaperLink(BaseModel):
    type: NonEmptyText
    url: HttpUrl


class PaperFactsCreate(BaseModel):
    title: NonEmptyText = Field(description="论文官方标题")
    title_zh: str | None = None
    authors: list[NonEmptyText] = Field(min_length=1)
    authors_complete: bool = True
    abstract: str | None = None
    publication_year: int | None = Field(default=None, ge=1800, le=2200)
    venue: str | None = None
    publication_state: PublicationState = PublicationState.UNKNOWN
    identifiers: list[PaperIdentifierInput] = Field(min_length=1)
    links: list[PaperLink] = Field(default_factory=list)

    @field_validator("authors")
    @classmethod
    def authors_must_be_unique(cls, value: list[str]) -> list[str]:
        if len({item.casefold() for item in value}) != len(value):
            raise ValueError("authors contains duplicate names")
        return value


class ProjectPaperCreate(BaseModel):
    status: PaperStatus = PaperStatus.DISCOVERED
    roles: list[PaperRole] = Field(default_factory=list)
    summary: str | None = None
    contributions: list[NonEmptyText] = Field(default_factory=list)
    relevance: str | None = None
    reading_focus: list[NonEmptyText] = Field(default_factory=list)

    @model_validator(mode="after")
    def included_requires_relevance(self) -> ProjectPaperCreate:
        if self.status == PaperStatus.INCLUDED and not (self.relevance or "").strip():
            raise ValueError("included paper requires relevance")
        return self


class PaperSubmission(BaseModel):
    paper: PaperFactsCreate
    project: ProjectPaperCreate = Field(default_factory=ProjectPaperCreate)


class PaperBatchCreate(BaseModel):
    papers: list[PaperSubmission] = Field(min_length=1, max_length=100)


class Paper(BaseModel):
    id: str
    identity_key: str
    title: str
    title_zh: str | None
    authors: list[str]
    authors_complete: bool
    abstract: str | None
    publication_year: int | None
    venue: str | None
    publication_state: PublicationState
    identifiers: list[PaperIdentifier]
    links: list[PaperLink]
    created_at: datetime
    updated_at: datetime


class ProjectPaper(BaseModel):
    id: str
    project_id: str
    paper_id: str
    status: PaperStatus
    roles: list[PaperRole]
    summary: str | None
    contributions: list[str]
    relevance: str | None
    reading_focus: list[str]
    created_at: datetime
    updated_at: datetime


class ProjectPaperView(BaseModel):
    paper: Paper
    project: ProjectPaper
    resources: list[Resource] = Field(default_factory=list)


class BatchOutcome(StrEnum):
    CREATED = "created"
    REUSED = "reused"
    UNCHANGED = "unchanged"


class PaperBatchItemResult(ProjectPaperView):
    outcome: BatchOutcome


class PaperBatchResult(BaseModel):
    results: list[PaperBatchItemResult]


class PaperPatch(BaseModel):
    title: NonEmptyText | None = None
    title_zh: str | None = None
    authors: list[NonEmptyText] | None = None
    authors_complete: bool | None = None
    abstract: str | None = None
    publication_year: int | None = Field(default=None, ge=1800, le=2200)
    venue: str | None = None
    publication_state: PublicationState | None = None
    identifiers: list[PaperIdentifierInput] | None = Field(default=None, min_length=1)
    links: list[PaperLink] | None = None

    @field_validator("authors")
    @classmethod
    def patched_authors_must_be_unique(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and len({item.casefold() for item in value}) != len(value):
            raise ValueError("authors contains duplicate names")
        return value


class ProjectPaperPatch(BaseModel):
    status: PaperStatus | None = None
    roles: list[PaperRole] | None = None
    summary: str | None = None
    contributions: list[NonEmptyText] | None = None
    relevance: str | None = None
    reading_focus: list[NonEmptyText] | None = None
