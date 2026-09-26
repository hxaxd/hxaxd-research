"""Project entity."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Project:
    """One registered workbench project.

    `id` is the stable identifier; `name` is display-only and may repeat or
    change without affecting the managed `directory`. `workspace_id` is the
    DSH workspace record bound to `directory`; it is null between directory
    creation and the first successful workspace binding, and the UI offers a
    retry for that window.
    """

    id: str
    name: str
    directory: str
    workspace_id: str | None
    created_at: str
    updated_at: str
