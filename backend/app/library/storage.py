from __future__ import annotations

import hashlib
import os
import re
import shutil
import tarfile
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from fastapi import UploadFile
from pypdf import PdfReader

from app.core.config import Settings

from .errors import InvalidAttachmentError
from .models import AttachmentType

MAX_ARCHIVE_UNPACKED_SIZE = 512 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 20_000


@dataclass(frozen=True)
class StagedObject:
    source: Path
    filename: str
    media_type: str
    sha256: str
    size: int


class AttachmentStorage:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.staging_root = settings.runtime_dir / "attachment-staging"

    def initialize(self) -> None:
        self.settings.artifact_dir.mkdir(parents=True, exist_ok=True)
        self.staging_root.mkdir(parents=True, exist_ok=True)

    async def stage_upload(
        self, upload: UploadFile, attachment_type: AttachmentType
    ) -> StagedObject:
        filename = self.safe_filename(upload.filename, attachment_type)
        descriptor, temporary = tempfile.mkstemp(prefix="attachment-", dir=self.staging_root)
        os.close(descriptor)
        path = Path(temporary)
        try:
            with path.open("wb") as output:
                while chunk := await upload.read(1024 * 1024):
                    output.write(chunk)
            self.validate(path, attachment_type)
            return self.describe(path, filename, upload.content_type, attachment_type)
        except Exception:
            path.unlink(missing_ok=True)
            raise

    def stage_generated(
        self, source: Path, filename: str, attachment_type: AttachmentType
    ) -> StagedObject:
        safe = self.safe_filename(filename, attachment_type)
        descriptor, temporary = tempfile.mkstemp(prefix="generated-", dir=self.staging_root)
        os.close(descriptor)
        path = Path(temporary)
        try:
            shutil.copyfile(source, path)
            self.validate(path, attachment_type)
            return self.describe(path, safe, None, attachment_type)
        except Exception:
            path.unlink(missing_ok=True)
            raise

    def commit(self, staged: StagedObject, item_id: str, attachment_id: str) -> str:
        relative = Path("artifacts") / item_id / attachment_id / staged.filename
        target = (self.settings.data_dir / relative).resolve()
        if self.settings.data_dir.resolve() not in target.parents:
            raise InvalidAttachmentError("附件目标路径非法")
        target.parent.mkdir(parents=True, exist_ok=False)
        try:
            os.replace(staged.source, target)
        except Exception:
            if target.parent.exists() and not any(target.parent.iterdir()):
                target.parent.rmdir()
            raise
        return relative.as_posix()

    def rollback_committed(self, storage_key: str) -> None:
        target = (self.settings.data_dir / storage_key).resolve()
        if self.settings.data_dir.resolve() not in target.parents:
            return
        target.unlink(missing_ok=True)
        parent = target.parent
        if parent.exists() and not any(parent.iterdir()):
            parent.rmdir()

    def resolve(self, storage_key: str) -> Path:
        target = (self.settings.data_dir / storage_key).resolve()
        if self.settings.data_dir.resolve() not in target.parents or not target.is_file():
            raise InvalidAttachmentError("附件文件不存在或路径非法")
        return target

    @staticmethod
    def validate(path: Path, attachment_type: AttachmentType) -> None:
        if not path.is_file() or path.stat().st_size < 32:
            raise InvalidAttachmentError("附件文件不存在或大小异常")
        if attachment_type == AttachmentType.FULLTEXT:
            try:
                reader = PdfReader(path, strict=True)
                if len(reader.pages) < 1:
                    raise InvalidAttachmentError("PDF 没有可读取页面")
                _ = reader.pages[0].mediabox
            except InvalidAttachmentError:
                raise
            except Exception as error:
                raise InvalidAttachmentError("PDF 无法解析") from error
        elif attachment_type == AttachmentType.SOURCE_ARCHIVE:
            AttachmentStorage._validate_archive(path)

    @staticmethod
    def _validate_archive(path: Path) -> None:
        try:
            if zipfile.is_zipfile(path):
                with zipfile.ZipFile(path) as archive:
                    members = archive.infolist()
                    if any(
                        (item.external_attr >> 16) & 0o170000 == 0o120000
                        for item in members
                    ):
                        raise InvalidAttachmentError("源码包不能包含符号链接")
                    entries = [
                        (item.filename, item.file_size, item.compress_size, item.is_dir())
                        for item in members
                    ]
            elif tarfile.is_tarfile(path):
                with tarfile.open(path) as archive:
                    members = archive.getmembers()
                    if any(item.issym() or item.islnk() or item.isdev() for item in members):
                        raise InvalidAttachmentError("源码包不能包含链接或设备文件")
                    entries = [
                        (item.name, item.size, max(item.size, 1), item.isdir())
                        for item in members
                    ]
            else:
                raise InvalidAttachmentError("源码附件必须是 zip、tar 或 tar.gz")
        except (tarfile.TarError, zipfile.BadZipFile) as error:
            raise InvalidAttachmentError("源码包损坏") from error
        if len(entries) > MAX_ARCHIVE_MEMBERS:
            raise InvalidAttachmentError("源码包文件数量异常")
        total = 0
        for name, size, compressed, is_directory in entries:
            pure = PurePosixPath(name.replace("\\", "/"))
            if pure.is_absolute() or ".." in pure.parts:
                raise InvalidAttachmentError("源码包包含越界路径")
            if is_directory:
                continue
            total += size
            if size > 64 * 1024 * 1024 or (compressed and size / compressed > 1000):
                raise InvalidAttachmentError("源码包包含异常压缩文件")
        if total > MAX_ARCHIVE_UNPACKED_SIZE:
            raise InvalidAttachmentError("源码包解压后过大")

    @staticmethod
    def safe_filename(filename: str | None, attachment_type: AttachmentType) -> str:
        fallback = "paper.pdf" if attachment_type == AttachmentType.FULLTEXT else "attachment.bin"
        name = Path(filename or fallback).name
        cleaned = re.sub(r"[^\w.()\-\u4e00-\u9fff ]", "_", name).strip(". ")
        return (cleaned or fallback)[:180]

    @staticmethod
    def describe(
        path: Path,
        filename: str,
        content_type: str | None,
        attachment_type: AttachmentType,
    ) -> StagedObject:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        media_type = (
            "application/pdf"
            if attachment_type == AttachmentType.FULLTEXT
            else content_type or "application/octet-stream"
        )
        return StagedObject(
            source=path,
            filename=filename,
            media_type=media_type,
            sha256=digest.hexdigest(),
            size=path.stat().st_size,
        )
