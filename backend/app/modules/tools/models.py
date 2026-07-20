from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


class ToolName(StrEnum):
    PDF2ZH = "pdf2zh"
    TEX = "tex"


class ToolStatus(StrEnum):
    MISSING = "missing"
    INSTALLING = "installing"
    INSTALLED = "installed"
    FAILED = "failed"


class ManagedTool(BaseModel):
    name: ToolName
    label: str
    description: str
    status: ToolStatus
    install_path: str = Field(description="由工作台管理的固定安装目录")
    executable_path: str | None
    version: str | None
    message: str
