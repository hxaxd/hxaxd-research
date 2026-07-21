from __future__ import annotations

from enum import StrEnum


class ScreeningError(RuntimeError):
    pass


class ScreeningNotFoundError(ScreeningError):
    pass


class ScreeningConflictError(ScreeningError):
    pass


class ProjectWorkStatus(StrEnum):
    DISCOVERED = "discovered"
    INCLUDED = "included"
    EXCLUDED = "excluded"
    ARCHIVED = "archived"


class CandidateState(StrEnum):
    STAGED = "staged"
    MATCHED = "matched"
    PROMOTED = "promoted"
    DISMISSED = "dismissed"
