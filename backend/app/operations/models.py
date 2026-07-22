from __future__ import annotations

from enum import StrEnum
from pathlib import PurePosixPath
from typing import Annotated
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator

from app.library.models import AttachmentOrigin, AttachmentType, LanguageMode


class _OperationModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ManagedToolName(StrEnum):
    PDF2ZH = "pdf2zh"
    TEX = "tex"


class ManagedToolStatus(StrEnum):
    MISSING = "missing"
    UPGRADE_REQUIRED = "upgrade_required"
    INSTALLING = "installing"
    READY = "ready"
    FAILED = "failed"


class ManagedTool(_OperationModel):
    name: ManagedToolName
    label: str
    description: str
    status: ManagedToolStatus
    version: str | None = None
    executable_path: str | None = None
    install_path: str
    message: str


class PublicManagedTool(_OperationModel):
    name: ManagedToolName
    label: str
    description: str
    status: ManagedToolStatus
    version: str | None = None
    message: str

    @classmethod
    def from_internal(cls, tool: ManagedTool) -> PublicManagedTool:
        return cls.model_validate(
            tool.model_dump(exclude={"executable_path", "install_path"})
        )


PreferencePurpose = Annotated[str, Field(min_length=1, max_length=80)]


class AttachmentDownloadRequest(_OperationModel):
    url: HttpUrl
    filename: str | None = Field(default=None, max_length=180)
    attachment_type: AttachmentType = AttachmentType.FULLTEXT
    language_mode: LanguageMode = LanguageMode.ORIGINAL
    origin: AttachmentOrigin = AttachmentOrigin.PREPRINT
    preferred_for: list[PreferencePurpose] = Field(default_factory=list, max_length=20)

    @field_validator("url")
    @classmethod
    def require_credential_free_https(cls, value: HttpUrl) -> HttpUrl:
        parsed = urlparse(str(value))
        if parsed.scheme != "https" or parsed.username or parsed.password:
            raise ValueError("只允许不含凭据的 HTTPS 下载地址")
        return value

    @field_validator("filename")
    @classmethod
    def require_basename(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if (
            not stripped
            or stripped in {".", ".."}
            or "/" in stripped
            or "\\" in stripped
        ):
            raise ValueError("文件名必须是不含路径的普通文件名")
        return stripped

    @field_validator("preferred_for")
    @classmethod
    def unique_preferences(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("附件用途不能重复")
        return value


class AttachmentDownloadJobInput(AttachmentDownloadRequest):
    item_id: str = Field(min_length=1, max_length=200)
    project_id: str = Field(min_length=1, max_length=200)


class CompileJobRequest(_OperationModel):
    main_tex: str | None = Field(default=None, max_length=300)

    @field_validator("main_tex")
    @classmethod
    def safe_relative_tex_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip().replace("\\", "/")
        path = PurePosixPath(normalized)
        if (
            not normalized
            or path.is_absolute()
            or ".." in path.parts
            or path.suffix.lower() != ".tex"
            or path.name.startswith("-")
        ):
            raise ValueError("TeX 主文件必须是源码包内的相对 .tex 路径")
        return path.as_posix()


class CompileJobInput(CompileJobRequest):
    attachment_id: str = Field(min_length=1, max_length=200)
    item_id: str = Field(min_length=1, max_length=200)
    project_id: str = Field(min_length=1, max_length=200)
