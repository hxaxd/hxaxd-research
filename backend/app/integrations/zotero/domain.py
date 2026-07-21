from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

from app.catalog.commands import CatalogCommands
from app.catalog.models import BibliographicItemView
from app.catalog.queries import CatalogQueries
from app.library.models import Attachment, GeneratedAttachment
from app.library.service import AttachmentService
from app.screening.commands import ScreeningCommands
from app.screening.models import CandidateCreate, CandidatePromotionRequest
from app.screening.queries import ScreeningQueries

from .mapping import draft_to_catalog_item
from .models import BibliographicDraft


class ZoteroDomainPort(Protocol):
    """Only public domain operations needed by deterministic synchronization."""

    def list_project_items(self, project_id: str) -> list[BibliographicItemView]: ...

    def list_catalog_items(self) -> list[BibliographicItemView]: ...

    def get_item(self, item_id: str) -> BibliographicItemView: ...

    def import_item(
        self,
        project_id: str,
        draft: BibliographicDraft,
        *,
        external_key: str,
        raw_payload: dict[str, Any],
    ) -> BibliographicItemView: ...

    def replace_item(
        self,
        project_id: str,
        item_id: str,
        draft: BibliographicDraft,
        *,
        external_key: str,
        raw_payload: dict[str, Any],
    ) -> BibliographicItemView: ...

    def list_attachments(self, item_id: str) -> list[Attachment]: ...

    def locate_attachment(self, attachment_id: str) -> tuple[Attachment, Path]: ...

    def import_pdf(
        self,
        item_id: str,
        path: Path,
        *,
        filename: str,
        source_url: str | None,
    ) -> Attachment: ...


class V3ZoteroDomainGateway:
    """Adapter that keeps every catalog, screening and file write behind its service."""

    def __init__(
        self,
        *,
        catalog_queries: CatalogQueries,
        catalog_commands: CatalogCommands,
        screening_queries: ScreeningQueries,
        screening_commands: ScreeningCommands,
        attachments: AttachmentService,
    ) -> None:
        self.catalog_queries = catalog_queries
        self.catalog_commands = catalog_commands
        self.screening_queries = screening_queries
        self.screening_commands = screening_commands
        self.attachments = attachments

    def list_project_items(self, project_id: str) -> list[BibliographicItemView]:
        self.screening_queries.get_project(project_id)
        result: list[BibliographicItemView] = []
        offset = 0
        while True:
            memberships = self.screening_queries.list_project_works(
                project_id, limit=500, offset=offset
            )
            result.extend(
                self.catalog_queries.get_item(membership.preferred_item_id)
                for membership in memberships
            )
            if len(memberships) < 500:
                return result
            offset += len(memberships)

    def list_catalog_items(self) -> list[BibliographicItemView]:
        result: list[BibliographicItemView] = []
        offset = 0
        while True:
            page = self.catalog_queries.list_works(limit=200, offset=offset)
            result.extend(
                next(item for item in work.items if item.is_preferred_for_work)
                for work in page.items
            )
            offset += len(page.items)
            if offset >= page.total:
                return result

    def get_item(self, item_id: str) -> BibliographicItemView:
        return self.catalog_queries.get_item(item_id)

    def import_item(
        self,
        project_id: str,
        draft: BibliographicDraft,
        *,
        external_key: str,
        raw_payload: dict[str, Any],
    ) -> BibliographicItemView:
        candidate = self.screening_commands.stage_candidate(
            project_id,
            CandidateCreate(
                item=draft_to_catalog_item(draft),
                source_provider="zotero",
                source_external_key=external_key,
                source_schema_version="web-api-v3",
                raw_payload=raw_payload,
                rationale="Imported from an explicitly confirmed Zotero transfer.",
            ),
            actor_type="system",
            correlation_id=f"zotero:{external_key}",
        )
        membership = self.screening_commands.promote_candidate(
            project_id,
            candidate.id,
            CandidatePromotionRequest(matched_work_id=candidate.matched_work_id),
            correlation_id=f"zotero:{external_key}",
        )
        return self.catalog_queries.get_item(membership.preferred_item_id)

    def replace_item(
        self,
        project_id: str,
        item_id: str,
        draft: BibliographicDraft,
        *,
        external_key: str,
        raw_payload: dict[str, Any],
    ) -> BibliographicItemView:
        current = self.catalog_queries.get_item(item_id)
        candidate = self.screening_commands.stage_candidate(
            project_id,
            CandidateCreate(
                item=draft_to_catalog_item(draft),
                source_provider="zotero",
                source_external_key=external_key,
                source_schema_version="web-api-v3",
                raw_payload=raw_payload,
                rationale="Updated by an explicitly confirmed Zotero transfer.",
            ),
            actor_type="system",
            correlation_id=f"zotero:{external_key}",
        )
        work = self.catalog_commands.append_item_version(
            current.work_id,
            draft_to_catalog_item(draft),
            source_record_id=candidate.source_record_id,
            actor_type="system",
            correlation_id=f"zotero:{external_key}",
        )
        preferred = next(item for item in work.items if item.is_preferred_for_work)
        self.screening_commands.promote_candidate(
            project_id,
            candidate.id,
            CandidatePromotionRequest(matched_work_id=current.work_id),
            correlation_id=f"zotero:{external_key}",
        )
        self._copy_attachments(item_id, preferred.id)
        return preferred

    def list_attachments(self, item_id: str) -> list[Attachment]:
        return self.attachments.list_for_item(item_id)

    def locate_attachment(self, attachment_id: str) -> tuple[Attachment, Path]:
        return self.attachments.locate(attachment_id)

    def import_pdf(
        self,
        item_id: str,
        path: Path,
        *,
        filename: str,
        source_url: str | None,
    ) -> Attachment:
        from app.library.models import (  # imported here to keep the adapter's surface small
            AttachmentFormat,
            AttachmentOrigin,
            AttachmentType,
            LanguageMode,
        )

        return self.attachments.register_generated_batch(
            item_id,
            [
                (
                    path,
                    GeneratedAttachment(
                        filename=filename,
                        attachment_type=AttachmentType.FULLTEXT,
                        format=AttachmentFormat.PDF,
                        language_mode=LanguageMode.ORIGINAL,
                        origin=AttachmentOrigin.ZOTERO,
                        source_url=source_url,
                        preferred_for=["reading", "pdf:original"],
                    ),
                )
            ],
            parent_attachment_id=None,
            job_id=None,
        )[0]

    def _copy_attachments(self, old_item_id: str, new_item_id: str) -> None:
        old = self.attachments.list_for_item(old_item_id)
        if not old:
            return
        outputs = []
        for attachment in old:
            _, path = self.attachments.locate(attachment.id)
            outputs.append(
                (
                    path,
                    GeneratedAttachment(
                        filename=attachment.filename,
                        attachment_type=attachment.attachment_type,
                        format=attachment.format,
                        language_mode=attachment.language_mode,
                        origin=attachment.origin,
                        source_url=attachment.source_url,
                        preferred_for=attachment.preferred_for,
                    ),
                )
            )
        self.attachments.register_generated_batch(
            new_item_id,
            outputs,
            parent_attachment_id=None,
            job_id=None,
        )
