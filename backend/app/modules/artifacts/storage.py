from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

from fastapi import UploadFile

from app.core.config import Settings
from app.core.errors import InvalidArtifactError
from app.modules.artifacts.models import ArtifactKind

FILE_NAMES = {
    ArtifactKind.ORIGINAL: "original.pdf",
    ArtifactKind.CHINESE: "chinese.pdf",
    ArtifactKind.BILINGUAL: "bilingual.pdf",
}


@dataclass(frozen=True)
class StoredPdf:
    relative_path: str
    sha256: str
    size: int


class LocalPdfStorage:
    def __init__(self, settings: Settings):
        self.settings = settings

    def initialize(self) -> None:
        self.settings.artifact_dir.mkdir(parents=True, exist_ok=True)

    async def save_upload(
        self,
        paper_id: str,
        kind: ArtifactKind,
        upload: UploadFile,
    ) -> StoredPdf:
        target = self._target(paper_id, kind)
        temporary = target.with_suffix(".uploading")
        try:
            with temporary.open("wb") as output:
                while chunk := await upload.read(1024 * 1024):
                    output.write(chunk)
            self._validate_pdf(temporary)
            os.replace(temporary, target)
            return self._describe(target)
        finally:
            if temporary.exists():
                temporary.unlink()

    def commit_generated(
        self,
        paper_id: str,
        kind: ArtifactKind,
        source: Path,
    ) -> StoredPdf:
        self._validate_pdf(source)
        target = self._target(paper_id, kind)
        if source.resolve() != target.resolve():
            os.replace(source, target)
        return self._describe(target)

    def resolve(self, relative_path: str) -> Path:
        path = (self.settings.data_dir / relative_path).resolve()
        if self.settings.data_dir.resolve() not in path.parents:
            raise InvalidArtifactError("数据库中的 PDF 路径越出数据目录")
        if not path.is_file():
            raise InvalidArtifactError("数据库记录的 PDF 文件不存在")
        return path

    def directory_for(self, paper_id: str) -> Path:
        path = (self.settings.artifact_dir / paper_id).resolve()
        if self.settings.artifact_dir.resolve() not in path.parents:
            raise InvalidArtifactError("论文文件目录非法")
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _target(self, paper_id: str, kind: ArtifactKind) -> Path:
        return self.directory_for(paper_id) / FILE_NAMES[kind]

    def _describe(self, path: Path) -> StoredPdf:
        return StoredPdf(
            relative_path=path.resolve().relative_to(self.settings.data_dir.resolve()).as_posix(),
            sha256=self._sha256(path),
            size=path.stat().st_size,
        )

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _validate_pdf(path: Path) -> None:
        if not path.is_file() or path.stat().st_size < 1024:
            raise InvalidArtifactError("PDF 文件不存在或大小异常")
        with path.open("rb") as source:
            if source.read(5) != b"%PDF-":
                raise InvalidArtifactError("文件没有有效的 PDF 头")
            source.seek(max(0, path.stat().st_size - 4096))
            if b"%%EOF" not in source.read():
                raise InvalidArtifactError("文件缺少 PDF 结束标记")
