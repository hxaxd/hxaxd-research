from __future__ import annotations

import hashlib
import os
import re
import tarfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from fastapi import UploadFile
from pypdf import PdfReader

from app.core.config import Settings
from app.core.errors import InvalidArtifactError

from .models import ResourceFormat

MAX_TEX_UNPACKED_SIZE = 512 * 1024 * 1024
MAX_TEX_MEMBERS = 20_000


@dataclass(frozen=True)
class StoredResource:
    relative_path: str
    filename: str
    media_type: str
    sha256: str
    size: int


class LocalResourceStorage:
    def __init__(self, settings: Settings):
        self.settings = settings

    def initialize(self) -> None:
        self.settings.artifact_dir.mkdir(parents=True, exist_ok=True)

    async def save_upload(
        self, paper_id: str, resource_id: str, format_: ResourceFormat, upload: UploadFile
    ) -> StoredResource:
        filename = self._safe_filename(upload.filename, format_)
        directory = self.settings.artifact_dir / paper_id / resource_id
        directory.mkdir(parents=True, exist_ok=False)
        target = directory / filename
        temporary = directory / f".{filename}.uploading"
        try:
            with temporary.open("wb") as output:
                while chunk := await upload.read(1024 * 1024):
                    output.write(chunk)
            self.validate(temporary, format_)
            os.replace(temporary, target)
            return self.describe(target, upload.content_type, format_)
        except Exception:
            temporary.unlink(missing_ok=True)
            if directory.exists() and not any(directory.iterdir()):
                directory.rmdir()
            raise

    def commit_generated(
        self,
        paper_id: str,
        resource_id: str,
        source: Path,
        filename: str,
        format_: ResourceFormat,
    ) -> StoredResource:
        self.validate(source, format_)
        directory = self.settings.artifact_dir / paper_id / resource_id
        directory.mkdir(parents=True, exist_ok=False)
        target = directory / self._safe_filename(filename, format_)
        os.replace(source, target)
        return self.describe(target, None, format_)

    def resolve(self, relative_path: str) -> Path:
        path = (self.settings.data_dir / relative_path).resolve()
        if self.settings.data_dir.resolve() not in path.parents or not path.is_file():
            raise InvalidArtifactError("资源文件不存在或路径非法")
        return path

    def describe(
        self, path: Path, content_type: str | None, format_: ResourceFormat
    ) -> StoredResource:
        media_type = (
            "application/pdf"
            if format_ == ResourceFormat.PDF
            else content_type or "application/octet-stream"
        )
        return StoredResource(
            relative_path=path.resolve().relative_to(self.settings.data_dir.resolve()).as_posix(),
            filename=path.name,
            media_type=media_type,
            sha256=self._sha256(path),
            size=path.stat().st_size,
        )

    @staticmethod
    def validate(path: Path, format_: ResourceFormat) -> None:
        if not path.is_file() or path.stat().st_size < 32:
            raise InvalidArtifactError("资源文件不存在或大小异常")
        if format_ == ResourceFormat.PDF:
            try:
                reader = PdfReader(path, strict=True)
                if len(reader.pages) < 1:
                    raise InvalidArtifactError("PDF 没有可读取页面")
                _ = reader.pages[0].mediabox
            except InvalidArtifactError:
                raise
            except Exception as error:
                raise InvalidArtifactError("PDF 无法解析") from error
        else:
            LocalResourceStorage._validate_tex_archive(path)

    @staticmethod
    def _validate_tex_archive(path: Path) -> None:
        try:
            if zipfile.is_zipfile(path):
                with zipfile.ZipFile(path) as archive:
                    members = archive.infolist()
                    if any((item.external_attr >> 16) & 0o170000 == 0o120000 for item in members):
                        raise InvalidArtifactError("TeX 源码包不能包含符号链接")
                    sizes = [
                        (item.filename, item.file_size, item.compress_size, item.is_dir())
                        for item in members
                    ]
            elif tarfile.is_tarfile(path):
                with tarfile.open(path) as archive:
                    members = archive.getmembers()
                    if any(item.issym() or item.islnk() or item.isdev() for item in members):
                        raise InvalidArtifactError("TeX 源码包不能包含链接或设备文件")
                    sizes = [
                        (item.name, item.size, max(item.size, 1), item.isdir()) for item in members
                    ]
            else:
                raise InvalidArtifactError("TeX 资源必须是 zip、tar 或 tar.gz 源码包")
        except (tarfile.TarError, zipfile.BadZipFile) as error:
            raise InvalidArtifactError("TeX 源码包损坏") from error
        if len(sizes) > MAX_TEX_MEMBERS:
            raise InvalidArtifactError("TeX 源码包文件数量异常")
        unpacked = 0
        for name, size, compressed, is_directory in sizes:
            pure = PurePosixPath(name.replace("\\", "/"))
            if pure.is_absolute() or ".." in pure.parts:
                raise InvalidArtifactError("TeX 源码包包含越界路径")
            if not is_directory:
                unpacked += size
                if size > 64 * 1024 * 1024 or (compressed and size / compressed > 1000):
                    raise InvalidArtifactError("TeX 源码包包含异常压缩文件")
        if unpacked > MAX_TEX_UNPACKED_SIZE:
            raise InvalidArtifactError("TeX 源码包解压后过大")

    @staticmethod
    def _safe_filename(filename: str | None, format_: ResourceFormat) -> str:
        fallback = "paper.pdf" if format_ == ResourceFormat.PDF else "source.zip"
        name = Path(filename or fallback).name
        name = re.sub(r"[^\w.()\-\u4e00-\u9fff ]", "_", name).strip(". ") or fallback
        return name[:180]

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
