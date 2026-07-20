from __future__ import annotations


class ApplicationError(Exception):
    """Base class for expected application failures."""


class ResourceNotFoundError(ApplicationError):
    pass


class ResourceConflictError(ApplicationError):
    pass


class InvalidArtifactError(ApplicationError):
    pass


class TranslationExecutionError(ApplicationError):
    pass


class InvalidSnapshotError(ApplicationError):
    pass
