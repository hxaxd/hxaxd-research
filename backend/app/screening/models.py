from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints, model_validator

from app.catalog.models import BibliographicItemDraft, BibliographicItemView

from .domain import CandidateState, ProjectWorkStatus

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ProjectCreate(BaseModel):
    name: NonEmptyText
    description: str = ""


class ProjectView(BaseModel):
    id: str
    name: str
    description: str
    work_count: int = 0
    status_counts: dict[str, int] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class CandidateCreate(BaseModel):
    item: BibliographicItemDraft
    source_provider: NonEmptyText = "manual"
    source_external_key: str | None = None
    source_url: str | None = None
    source_schema_version: str | None = None
    raw_payload: dict[str, Any] | None = None
    discovery_session_id: str | None = None
    dedupe_key: str | None = None
    rank: float | None = None
    rationale: str | None = None


class CandidateEvidence(BaseModel):
    id: str
    provider: str
    external_key: str | None = None
    url: str | None = None
    captured_at: datetime | None = None
    summary: str | None = None
    fields: dict[str, Any] = Field(default_factory=dict)


class CandidateView(BaseModel):
    id: str
    project_id: str
    discovery_session_id: str | None
    source_record_id: str | None
    state: CandidateState
    item: BibliographicItemDraft
    dedupe_key: str | None
    matched_work_id: str | None
    matched_item: BibliographicItemView | None = None
    rank: float | None
    rationale: str | None
    evidence: list[CandidateEvidence] = Field(default_factory=list)
    created_at: datetime
    resolved_at: datetime | None


class CandidatePromotionRequest(BaseModel):
    matched_work_id: str | None = None


class CandidateDecision(BaseModel):
    candidate_id: str
    decision: Literal["include", "exclude"]
    matched_work_id: str | None = None
    reason: str | None = None


class CandidateDecisionBatch(BaseModel):
    decisions: list[CandidateDecision] = Field(min_length=1, max_length=100)


class CandidateDecisionResult(BaseModel):
    candidate: CandidateView
    project_item: ProjectWorkView


class ProjectWorkDecision(BaseModel):
    status: ProjectWorkStatus | None = None
    roles: list[NonEmptyText] | None = None
    summary: str | None = None
    relevance: str | None = None
    contributions: list[NonEmptyText] | None = None
    reading_focus: list[NonEmptyText] | None = None


class ProjectInsightsPatch(BaseModel):
    roles: list[NonEmptyText] = Field(default_factory=list)
    summary: str | None = None
    relevance: str | None = None
    contributions: list[NonEmptyText] = Field(default_factory=list)
    reading_focus: list[NonEmptyText] = Field(default_factory=list)

    @model_validator(mode="after")
    def require_a_real_patch(self) -> ProjectInsightsPatch:
        if not self.model_fields_set:
            raise ValueError("project insights patch must contain at least one field")
        return self


class ProjectWorkView(BaseModel):
    id: str
    project_id: str
    work_id: str
    status: ProjectWorkStatus
    roles: list[str]
    summary: str | None
    relevance: str | None
    contributions: list[str]
    reading_focus: list[str]
    preferred_item_id: str
    title: str
    translated_title: str | None
    item_type: str
    issued_year: int | None
    decided_at: datetime | None
    decided_by: str | None
    created_at: datetime
    updated_at: datetime
