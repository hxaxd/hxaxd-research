from __future__ import annotations

from pathlib import Path

from fastapi import UploadFile

from app.modules.papers.repository import SqlitePaperRepository
from app.utils.identity import new_id
from app.utils.time import utc_now

from .models import (
    Resource,
    ResourceFormat,
    ResourceOrigin,
    ResourcePatch,
    ResourceRepresentation,
)
from .repository import SqliteResourceRepository
from .storage import LocalResourceStorage, StoredResource


class ResourceService:
    def __init__(
        self,
        repository: SqliteResourceRepository,
        storage: LocalResourceStorage,
        papers: SqlitePaperRepository,
    ):
        self.repository = repository
        self.storage = storage
        self.papers = papers

    def list_by_paper(self, paper_id: str) -> list[Resource]:
        self.papers.get(paper_id)
        return self.repository.list_by_paper(paper_id)

    async def save_upload(
        self,
        paper_id: str,
        upload: UploadFile,
        format_: ResourceFormat,
        representation: ResourceRepresentation,
        origin: ResourceOrigin,
        source_url: str | None,
        preferred: bool,
    ) -> Resource:
        self.papers.get(paper_id)
        resource_id = new_id()
        stored = await self.storage.save_upload(paper_id, resource_id, format_, upload)
        return self._register(
            resource_id,
            paper_id,
            format_,
            representation,
            origin,
            source_url,
            preferred,
            None,
            None,
            stored,
        )

    def register_generated(
        self,
        paper_id: str,
        source: Path,
        filename: str,
        representation: ResourceRepresentation,
        parent_resource_id: str,
        job_id: str,
    ) -> Resource:
        resource_id = new_id()
        stored = self.storage.commit_generated(
            paper_id, resource_id, source, filename, ResourceFormat.PDF
        )
        preferred = representation != ResourceRepresentation.ORIGINAL or not any(
            item.format == ResourceFormat.PDF
            and item.representation == ResourceRepresentation.ORIGINAL
            for item in self.repository.list_by_paper(paper_id)
        )
        return self._register(
            resource_id,
            paper_id,
            ResourceFormat.PDF,
            representation,
            ResourceOrigin.GENERATED,
            None,
            preferred,
            parent_resource_id,
            job_id,
            stored,
        )

    def patch(self, resource_id: str, payload: ResourcePatch) -> Resource:
        return self.repository.patch(
            resource_id, payload.model_dump(exclude_unset=True, mode="json")
        )

    def locate(self, resource_id: str) -> tuple[Resource, Path]:
        resource = self.repository.get(resource_id)
        return resource, self.storage.resolve(self.repository.relative_path(resource_id))

    def _register(
        self,
        resource_id: str,
        paper_id: str,
        format_: ResourceFormat,
        representation: ResourceRepresentation,
        origin: ResourceOrigin,
        source_url: str | None,
        preferred: bool,
        parent_resource_id: str | None,
        job_id: str | None,
        stored: StoredResource,
    ) -> Resource:
        resource = Resource(
            id=resource_id,
            paper_id=paper_id,
            format=format_,
            representation=representation,
            origin=origin,
            source_url=source_url,
            filename=stored.filename,
            media_type=stored.media_type,
            sha256=stored.sha256,
            size=stored.size,
            preferred=preferred,
            parent_resource_id=parent_resource_id,
            job_id=job_id,
            created_at=utc_now(),
        )
        return self.repository.save(resource, stored.relative_path)
