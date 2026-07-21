from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class PromptContext(BaseModel):
    objective: str = Field(min_length=1)
    scope: dict[str, Any] = Field(default_factory=dict)
    project: dict[str, Any] | None = None
    items: list[dict[str, Any]] = Field(default_factory=list)
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    task_data: dict[str, Any] = Field(default_factory=dict)
    capabilities: dict[str, Any] = Field(default_factory=dict)
    prior_decisions: list[dict[str, Any]] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)


class PromptSnapshot(BaseModel):
    version: str
    context_hash: str
    prompt: str
    context: dict[str, Any]
