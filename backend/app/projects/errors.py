"""Project domain errors."""

from __future__ import annotations


class ProjectError(RuntimeError):
    """Base class for project domain failures."""


class ProjectValidationError(ProjectError):
    """The requested project identity is not usable (name, request id)."""


class DirectoryConflictError(ProjectError):
    """The managed directory already exists and is not an empty artifact of a
    failed earlier attempt."""


class ProjectNotFoundError(ProjectError):
    """No project is registered under the requested id."""
