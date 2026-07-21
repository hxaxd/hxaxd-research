from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints, model_validator

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class CreatorInput(BaseModel):
    role: NonEmptyText = "author"
    creator_type: str = Field(default="literal", pattern="^(person|organization|literal)$")
    given_name: str | None = None
    family_name: str | None = None
    literal_name: str | None = None
    suffix: str | None = None
    orcid: str | None = None
    raw_name: NonEmptyText

    @model_validator(mode="after")
    def has_a_name(self) -> CreatorInput:
        if not any(
            (
                (self.given_name or "").strip(),
                (self.family_name or "").strip(),
                (self.literal_name or "").strip(),
            )
        ):
            raise ValueError("creator requires a structured or literal name")
        return self


class IdentifierInput(BaseModel):
    scheme: NonEmptyText
    value: NonEmptyText
    is_primary: bool = False


class LinkInput(BaseModel):
    relation_type: NonEmptyText = "related"
    url: NonEmptyText
    title: str | None = None


class TagInput(BaseModel):
    name: NonEmptyText
    kind: NonEmptyText = "keyword"


class BibliographicItemDraft(BaseModel):
    item_type: NonEmptyText = "document"
    title: NonEmptyText
    short_title: str | None = None
    translated_title: str | None = None
    abstract: str | None = None
    language: str | None = None
    issued_year: int | None = Field(default=None, ge=1000, le=3000)
    issued_month: int | None = Field(default=None, ge=1, le=12)
    issued_day: int | None = Field(default=None, ge=1, le=31)
    issued_literal: str | None = None
    container_title: str | None = None
    publisher: str | None = None
    place: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    edition: str | None = None
    series: str | None = None
    publication_state: str = Field(
        default="unknown",
        pattern="^(preprint|submitted|accepted|published|retracted|unknown)$",
    )
    creator_list_complete: bool = True
    creators: list[CreatorInput] = Field(default_factory=list)
    identifiers: list[IdentifierInput] = Field(default_factory=list)
    links: list[LinkInput] = Field(default_factory=list)
    tags: list[TagInput] = Field(default_factory=list)


class BibliographicItemPatch(BaseModel):
    item_type: NonEmptyText | None = None
    title: NonEmptyText | None = None
    short_title: str | None = None
    translated_title: str | None = None
    abstract: str | None = None
    language: str | None = None
    issued_year: int | None = Field(default=None, ge=1000, le=3000)
    issued_month: int | None = Field(default=None, ge=1, le=12)
    issued_day: int | None = Field(default=None, ge=1, le=31)
    issued_literal: str | None = None
    container_title: str | None = None
    publisher: str | None = None
    place: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    edition: str | None = None
    series: str | None = None
    publication_state: str | None = Field(
        default=None,
        pattern="^(preprint|submitted|accepted|published|retracted|unknown)$",
    )
    creator_list_complete: bool | None = None
    creators: list[CreatorInput] = Field(default_factory=list)
    identifiers: list[IdentifierInput] = Field(default_factory=list)
    links: list[LinkInput] = Field(default_factory=list)
    tags: list[TagInput] = Field(default_factory=list)

    @model_validator(mode="after")
    def require_a_real_patch(self) -> BibliographicItemPatch:
        if not self.model_fields_set:
            raise ValueError("metadata patch must contain at least one field")
        non_nullable = {"item_type", "title", "publication_state", "creator_list_complete"}
        for field in non_nullable & self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class CreatorView(CreatorInput):
    id: str
    position: int


class IdentifierView(BaseModel):
    id: str
    scheme: str
    value: str
    normalized_value: str
    version: str | None
    is_primary: bool
    is_identity: bool


class LinkView(LinkInput):
    id: str


class TagView(TagInput):
    pass


class BibliographicItemView(BaseModel):
    id: str
    work_id: str
    revision: int
    item_type: str
    title: str
    short_title: str | None
    translated_title: str | None
    abstract: str | None
    language: str | None
    issued_year: int | None
    issued_month: int | None
    issued_day: int | None
    issued_literal: str | None
    container_title: str | None
    publisher: str | None
    place: str | None
    volume: str | None
    issue: str | None
    pages: str | None
    edition: str | None
    series: str | None
    publication_state: str
    creator_list_complete: bool
    is_preferred_for_work: bool
    creators: list[CreatorView] = Field(default_factory=list)
    identifiers: list[IdentifierView] = Field(default_factory=list)
    links: list[LinkView] = Field(default_factory=list)
    tags: list[TagView] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class WorkView(BaseModel):
    id: str
    items: list[BibliographicItemView]
    created_at: datetime
    updated_at: datetime


class WorkList(BaseModel):
    items: list[WorkView]
    total: int
    limit: int
    offset: int
