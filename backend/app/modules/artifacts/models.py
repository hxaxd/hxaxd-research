from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel


class ArtifactKind(StrEnum):
    ORIGINAL = "original"
    CHINESE = "chinese"
    BILINGUAL = "bilingual"


class Artifact(BaseModel):
    id: str
    paper_id: str
    kind: ArtifactKind
    filename: str
    relative_path: str
    sha256: str
    size: int
    created_at: datetime
