from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, HttpUrl


class ResourceFormat(StrEnum):
    PDF = "pdf"
    TEX = "tex"


class ResourceRepresentation(StrEnum):
    ORIGINAL = "original"
    TRANSLATED = "translated"
    BILINGUAL = "bilingual"


class ResourceOrigin(StrEnum):
    PUBLISHER = "publisher"
    PREPRINT = "preprint"
    AUTHOR = "author"
    USER = "user"
    GENERATED = "generated"
    LEGACY = "legacy"


class Resource(BaseModel):
    id: str
    paper_id: str
    format: ResourceFormat
    representation: ResourceRepresentation
    origin: ResourceOrigin
    source_url: str | None
    filename: str
    media_type: str
    sha256: str
    size: int
    preferred: bool
    parent_resource_id: str | None
    job_id: str | None
    created_at: datetime


class ResourcePatch(BaseModel):
    preferred: bool | None = None
    source_url: HttpUrl | None = None
    origin: ResourceOrigin | None = None
