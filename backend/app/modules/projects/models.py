from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ProjectCreate(BaseModel):
    name: NonEmptyText = Field(description="领域或学习项目名称")
    description: str = Field(default="", description="项目范围和边界")


class Project(ProjectCreate):
    id: str
    created_at: datetime
    updated_at: datetime


class ProjectSummary(Project):
    paper_count: int
