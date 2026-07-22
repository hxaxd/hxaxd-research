from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class _PreferencesModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ReaderPreferences(_PreferencesModel):
    target_language: str = Field(default="zh-CN", min_length=2, max_length=40)
    default_mode: Literal["source", "bilingual", "translation"] = "source"
    default_panel: Literal["structured", "pdf", "split"] = "structured"
    font_family: Literal["serif", "sans", "system"] = "serif"
    font_size: Literal["small", "medium", "large"] = "medium"
    line_height: Literal["compact", "standard", "relaxed"] = "standard"
    measure: Literal["focused", "balanced", "wide"] = "balanced"
    density: Literal["compact", "comfortable"] = "comfortable"
    flow: Literal["continuous", "paged"] = "continuous"
    columns: Literal["auto", "single", "double"] = "auto"
    theme: Literal["dark", "light", "sepia"] = "dark"
    show_outline: bool = True
    restore_position: bool = True
    large_touch_targets: bool = True
    reduce_motion: bool = False


class BilingualPreferences(_PreferencesModel):
    layout: Literal["side_by_side", "stacked"] = "side_by_side"
    highlight_terms: bool = True
    synchronize_blocks: bool = True


class PdfPreferences(_PreferencesModel):
    color_mode: Literal["original", "dark", "sepia"] = "original"
    default_zoom: Literal["auto", "page_width", "page_fit"] = "page_width"
    toolbar_density: Literal["compact", "comfortable"] = "comfortable"
    restore_position: bool = True


class GlossaryPreference(_PreferencesModel):
    source_term: str = Field(min_length=1, max_length=300)
    translated_term: str = Field(min_length=1, max_length=300)

    @field_validator("source_term", "translated_term")
    @classmethod
    def normalize_term(cls, value: str) -> str:
        return value.strip()


class TranslationPreferences(_PreferencesModel):
    provider: str = Field(default="deepseek", min_length=1, max_length=80)
    model: str = Field(default="deepseek-v4-flash", min_length=1, max_length=160)
    style: Literal["faithful_academic", "natural_academic", "concise"] = "faithful_academic"
    batching: Literal["whole_with_fallback", "whole_only", "chapter"] = "whole_with_fallback"
    glossary: list[GlossaryPreference] = Field(default_factory=list, max_length=500)
    retranslate_scope: Literal["changed", "document"] = "changed"


class AgentPreferences(_PreferencesModel):
    default_runtime: Literal["codex", "pi", "opencode", "claude-code"] = "codex"
    model: str | None = Field(default=None, max_length=160)
    reasoning_effort: Literal["low", "medium", "high", "xhigh"] = "high"
    enabled_capabilities: list[
        Literal[
            "catalog_read",
            "candidate_propose",
            "metadata_propose",
            "resource_propose",
            "zotero_conflict_propose",
            "web_search",
        ]
    ] = Field(
        default_factory=lambda: [
            "catalog_read",
            "candidate_propose",
            "metadata_propose",
            "resource_propose",
            "zotero_conflict_propose",
            "web_search",
        ]
    )
    context_summary: Literal["compact", "balanced", "detailed"] = "balanced"

    @field_validator("enabled_capabilities")
    @classmethod
    def capabilities_are_unique(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("智能体能力不能重复")
        return values


class TaskPreferences(_PreferencesModel):
    notify_on_success: bool = True
    notify_on_failure: bool = True
    auto_open_result: bool = False
    max_concurrent_jobs: int = Field(default=2, ge=1, le=8)


class UserPreferences(_PreferencesModel):
    revision: int = Field(ge=0)
    reader: ReaderPreferences = Field(default_factory=ReaderPreferences)
    bilingual: BilingualPreferences = Field(default_factory=BilingualPreferences)
    pdf: PdfPreferences = Field(default_factory=PdfPreferences)
    translation: TranslationPreferences = Field(default_factory=TranslationPreferences)
    agent: AgentPreferences = Field(default_factory=AgentPreferences)
    tasks: TaskPreferences = Field(default_factory=TaskPreferences)
    updated_at: datetime | None = None


class UserPreferencesUpdate(_PreferencesModel):
    expected_revision: int = Field(ge=0)
    reader: ReaderPreferences
    bilingual: BilingualPreferences
    pdf: PdfPreferences
    translation: TranslationPreferences
    agent: AgentPreferences
    tasks: TaskPreferences
