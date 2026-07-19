from __future__ import annotations

from pathlib import Path

from fastapi import UploadFile

from app.modules.papers.repository import SqlitePaperRepository
from app.utils.identity import new_id
from app.utils.time import utc_now

from .models import Artifact, ArtifactKind
from .repository import SqliteArtifactRepository
from .storage import LocalPdfStorage, StoredPdf


class ArtifactService:
    def __init__(
        self,
        repository: SqliteArtifactRepository,
        storage: LocalPdfStorage,
        papers: SqlitePaperRepository,
    ):
        self.repository = repository
        self.storage = storage
        self.papers = papers

    def list_by_paper(self, paper_id: str) -> list[Artifact]:
        self.papers.get(paper_id)
        return self.repository.list_by_paper(paper_id)

    async def save_upload(
        self,
        paper_id: str,
        kind: ArtifactKind,
        upload: UploadFile,
    ) -> Artifact:
        self.papers.get(paper_id)
        stored = await self.storage.save_upload(
            paper_id,
            kind,
            upload,
        )
        return self._register(paper_id, kind, stored)

    def register_generated(
        self,
        paper_id: str,
        kind: ArtifactKind,
        source: Path,
    ) -> Artifact:
        stored = self.storage.commit_generated(paper_id, kind, source)
        return self._register(paper_id, kind, stored)

    def locate(self, paper_id: str, kind: ArtifactKind) -> tuple[Artifact, Path]:
        artifact = self.repository.get(paper_id, kind)
        return artifact, self.storage.resolve(artifact.relative_path)

    def directory_for(self, paper_id: str) -> Path:
        return self.storage.directory_for(paper_id)

    def _register(
        self,
        paper_id: str,
        kind: ArtifactKind,
        stored: StoredPdf,
    ) -> Artifact:
        return self.repository.upsert(
            Artifact(
                id=new_id(),
                paper_id=paper_id,
                kind=kind,
                filename=Path(stored.relative_path).name,
                relative_path=stored.relative_path,
                sha256=stored.sha256,
                size=stored.size,
                created_at=utc_now(),
            )
        )
