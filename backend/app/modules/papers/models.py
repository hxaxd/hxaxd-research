from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, Field, HttpUrl, StringConstraints, field_validator

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class PaperStatus(StrEnum):
    DISCOVERED = "discovered"
    INCLUDED = "included"
    EXCLUDED = "excluded"
    ARCHIVED = "archived"


class PaperType(StrEnum):
    SURVEY = "综述"
    FOUNDATIONAL = "奠基"
    METHOD = "方法"
    SYSTEM = "系统"
    BENCHMARK = "Benchmark"
    COUNTEREXAMPLE = "反例"
    ADJACENT = "相邻工作"


class PaperCreate(BaseModel):
    stable_key: NonEmptyText = Field(
        description="稳定去重键，优先使用 DOI，其次 arXiv ID 或稳定 URL"
    )
    status: PaperStatus = PaperStatus.DISCOVERED
    title_en: NonEmptyText = Field(description="论文官方英文标题，不得自行改写")
    title_zh: NonEmptyText = Field(description="论文中文标题")
    authors: list[NonEmptyText] = Field(min_length=1, description="按原始顺序排列的作者")
    organization: str | None = Field(
        default=None, description="已核验的第一作者所属组织；未核验时为 null"
    )
    publication_year: int = Field(ge=1800, le=2200)
    publication_status: NonEmptyText = Field(description="预印本或正式会议、期刊及年份")
    paper_type: PaperType
    main_method: NonEmptyText = Field(description="论文主要方法的一句话说明")
    contribution: NonEmptyText = Field(description="论文的核心贡献")
    selection_reason: NonEmptyText = Field(description="该论文在知识结构中不可替代的作用")
    reading_focus: NonEmptyText = Field(description="阅读时应关注的章节、实验或论证")
    relations: NonEmptyText = Field(description="与其他论文的延续、反驳、扩展或评测关系")
    stable_url: HttpUrl = Field(description="DOI、arXiv、OpenReview 等稳定页面")
    code_url: HttpUrl | None = None
    website_url: HttpUrl | None = None

    @field_validator("authors")
    @classmethod
    def authors_must_be_unique(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("authors contains duplicate names")
        return value


class Paper(PaperCreate):
    id: str
    project_id: str
    created_at: datetime
    updated_at: datetime


class PaperPatch(BaseModel):
    status: PaperStatus | None = None
    title_zh: NonEmptyText | None = None
    organization: str | None = None
    publication_status: NonEmptyText | None = None
    paper_type: PaperType | None = None
    main_method: NonEmptyText | None = None
    contribution: NonEmptyText | None = None
    selection_reason: NonEmptyText | None = None
    reading_focus: NonEmptyText | None = None
    relations: NonEmptyText | None = None
    stable_url: HttpUrl | None = None
    code_url: HttpUrl | None = None
    website_url: HttpUrl | None = None


class PaperBatchCreate(BaseModel):
    papers: list[PaperCreate] = Field(min_length=1, max_length=100)


class PaperBatchResult(BaseModel):
    created: list[Paper]
