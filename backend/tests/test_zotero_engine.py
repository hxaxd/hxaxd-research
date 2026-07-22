from __future__ import annotations

import hashlib
from datetime import UTC, datetime

import pytest

from app.catalog.commands import CatalogCommands
from app.catalog.models import BibliographicItemDraft, IdentifierInput
from app.catalog.queries import CatalogQueries
from app.integrations.zotero.domain import V3ZoteroDomainGateway
from app.integrations.zotero.engine import (
    ZoteroCapabilityUnavailableError,
    ZoteroSyncEngine,
)
from app.integrations.zotero.http import ZoteroHttpError
from app.integrations.zotero.models import (
    TransferExecuteRequest,
    TransferPreviewRequest,
    ZoteroAttachmentUploadResult,
    ZoteroLibraryKind,
    ZoteroLibraryRef,
)
from app.integrations.zotero.planner import ZoteroDiffPlanner
from app.integrations.zotero.repository import SqliteZoteroTransferRepository
from app.integrations.zotero.service import ZoteroTransferService
from app.library.repository import AttachmentRepository
from app.library.service import AttachmentService
from app.library.storage import AttachmentStorage
from app.platform.db import WorkspaceDatabase
from app.screening.commands import ScreeningCommands
from app.screening.models import CandidateCreate, CandidatePromotionRequest, ProjectCreate
from app.screening.queries import ScreeningQueries
from tests.sample_data import PDF

NOW = datetime(2026, 7, 21, 8, 0, tzinfo=UTC)
LIBRARY = ZoteroLibraryRef(kind=ZoteroLibraryKind.USER, id="123")


def _services(app_settings):
    database = WorkspaceDatabase(app_settings.database_path)
    database.initialize()
    storage = AttachmentStorage(app_settings)
    storage.initialize()
    attachment_service = AttachmentService(AttachmentRepository(database), storage)
    catalog_queries = CatalogQueries(database)
    catalog_commands = CatalogCommands(database)
    screening_queries = ScreeningQueries(database)
    screening_commands = ScreeningCommands(database)
    gateway = V3ZoteroDomainGateway(
        catalog_queries=catalog_queries,
        catalog_commands=catalog_commands,
        screening_queries=screening_queries,
        screening_commands=screening_commands,
        attachments=attachment_service,
    )
    repository = SqliteZoteroTransferRepository(database, clock=lambda: NOW)
    return (
        database,
        gateway,
        repository,
        screening_queries,
        screening_commands,
        attachment_service,
    )


class FakeLocalClient:
    def __init__(self, pdf_path):
        self.pdf_path = pdf_path
        self.item = {
            "key": "REMOTE1",
            "version": 7,
            "data": {
                "key": "REMOTE1",
                "version": 7,
                "itemType": "journalArticle",
                "title": "Imported deterministically",
                "DOI": "10.1000/imported",
                "tags": [{"tag": "agent", "type": 1, "color": "purple"}],
                "collections": ["COLL0001"],
                "customFutureField": {"nested": True},
            },
        }
        self.attachment = {
            "key": "REMOTEPDF",
            "version": 2,
            "data": {
                "key": "REMOTEPDF",
                "version": 2,
                "itemType": "attachment",
                "linkMode": "imported_file",
                "title": "paper.pdf",
                "filename": "paper.pdf",
                "contentType": "application/pdf",
                "filesize": len(PDF),
                "md5": hashlib.md5(PDF, usedforsecurity=False).hexdigest(),
            },
        }

    def probe(self):
        return True

    def list_items(self, **kwargs):
        del kwargs
        return [self.item]

    def list_children(self, item_key, **kwargs):
        del kwargs
        return [self.attachment] if item_key == "REMOTE1" else []

    def attachment_file_path(self, item_key, **kwargs):
        del kwargs
        assert item_key == "REMOTEPDF"
        return self.pdf_path

    def get_item(self, item_key, **kwargs):
        del kwargs
        assert item_key == "REMOTE1"
        return self.item


def test_local_read_only_import_builds_server_preview_and_writes_through_v3_services(
    app_settings, tmp_path
):
    (
        _,
        gateway,
        repository,
        screening_queries,
        screening_commands,
        attachment_service,
    ) = _services(app_settings)
    project = screening_commands.create_project(ProjectCreate(name="Import project"))
    pdf = tmp_path / "source.pdf"
    pdf.write_bytes(PDF)
    local = FakeLocalClient(pdf)
    engine = ZoteroSyncEngine(
        domain=gateway,
        repository=repository,
        local_client=local,
        web_client=None,
    )
    service = ZoteroTransferService(
        repository,
        engine,
        planner=ZoteroDiffPlanner(clock=lambda: NOW),
        clock=lambda: NOW,
    )

    status = service.status()
    assert status.import_available is True
    assert status.export_available is False
    request = TransferPreviewRequest(direction="import", library=LIBRARY, project_id=project.id)
    preview = service.create_preview(request)
    assert preview.summary.new == 1
    assert preview.items[0].source.title == "Imported deterministically"
    assert preview.items[0].attachments[0].action == "new"

    receipt = service.execute(
        preview.id,
        TransferExecuteRequest(confirmed=True, expected_preview_hash=preview.preview_hash),
    )

    assert receipt.status == "succeeded"
    membership = screening_queries.list_project_works(project.id).items[0]
    attachments = attachment_service.list_for_item(membership.preferred_item_id)
    assert attachments[0].origin == "zotero"
    assert attachments[0].sha256 == hashlib.sha256(PDF).hexdigest()
    binding = repository.get_binding_by_external(LIBRARY, "bibliographic_item", "REMOTE1")
    assert binding is not None
    assert binding.entity_id == membership.preferred_item_id
    assert binding.raw["remote_draft"]["collections"] == ["COLL0001"]
    assert gateway.get_item(membership.preferred_item_id).tags[0].name == "agent"

    local.item["version"] = 8
    local.item["data"]["version"] = 8
    local.item["data"]["title"] = "Imported as an immutable second version"
    update_preview = service.create_preview(request)
    assert update_preview.summary.update == 1
    update_receipt = service.execute(
        update_preview.id,
        TransferExecuteRequest(confirmed=True, expected_preview_hash=update_preview.preview_hash),
    )
    assert update_receipt.items[0].outcome == "updated"
    updated_membership = screening_queries.list_project_works(project.id).items[0]
    assert updated_membership.preferred_item_id != membership.preferred_item_id
    work = gateway.catalog_queries.get_work(updated_membership.work_id)
    assert [item.title for item in work.items] == [
        "Imported as an immutable second version",
        "Imported deterministically",
    ]
    assert len(attachment_service.list_for_item(updated_membership.preferred_item_id)) == 1
    moved = repository.get_binding_by_external(LIBRARY, "bibliographic_item", "REMOTE1")
    assert moved is not None
    assert moved.entity_id == updated_membership.preferred_item_id
    unchanged_preview = service.create_preview(request)
    assert unchanged_preview.summary.unchanged == 1
    assert unchanged_preview.summary.conflict == 0

    with pytest.raises(ZoteroCapabilityUnavailableError):
        service.create_preview(
            TransferPreviewRequest(direction="export", library=LIBRARY, project_id=project.id)
        )


class FakeWebClient:
    def __init__(self):
        self.item = None
        self.children = []
        self.uploaded_paths = []
        self.create_calls = 0
        self.attachment_create_calls = 0
        self.attachment_upload_calls = 0

    def list_items(self, library, **kwargs):
        del library, kwargs
        return [self.item] if self.item is not None else []

    def list_children(self, library, item_key, **kwargs):
        del library, item_key, kwargs
        return list(self.children)

    def create_items(self, library, items, **kwargs):
        del library, kwargs
        self.create_calls += 1
        item_key = items[0].get("key", "ZKEY0001")
        data = {**items[0], "key": item_key, "version": 1}
        self.item = {"key": item_key, "version": 1, "data": data}
        return {"success": {"0": item_key}}

    def create_and_upload_attachment(
        self, library, *, parent_item, file_path, content_type, title, **kwargs
    ):
        del library, content_type
        self.attachment_create_calls += 1
        item_key = kwargs.get("object_key") or "ZPDF0001"
        content = file_path.read_bytes()
        self.uploaded_paths.append(file_path)
        md5 = hashlib.md5(content, usedforsecurity=False).hexdigest()
        self.children.append(
            {
                "key": item_key,
                "version": 2,
                "data": {
                    "key": item_key,
                    "version": 2,
                    "itemType": "attachment",
                    "parentItem": parent_item,
                    "filename": title,
                    "contentType": "application/pdf",
                    "filesize": len(content),
                    "md5": md5,
                },
            }
        )
        return ZoteroAttachmentUploadResult(
            item_key=item_key,
            filename=title,
            md5=md5,
            size=len(content),
            existed=False,
            library_version=2,
        )

    def get_item(self, library, item_key):
        del library
        if self.item is not None and item_key == self.item["key"]:
            return self.item
        child = next((value for value in self.children if value["key"] == item_key), None)
        if child is None:
            raise ZoteroHttpError("missing", status=404)
        return child

    def upload_attachment_file(self, library, item_key, file_path):
        del library
        self.attachment_upload_calls += 1
        child = self.get_item(LIBRARY, item_key)
        content = file_path.read_bytes()
        md5 = hashlib.md5(content, usedforsecurity=False).hexdigest()
        child["data"]["md5"] = md5
        return ZoteroAttachmentUploadResult(
            item_key=item_key,
            filename=file_path.name,
            md5=md5,
            size=len(content),
            existed=True,
            library_version=child["version"],
        )


def test_export_writes_metadata_and_pdf_then_establishes_unchanged_baseline(app_settings, tmp_path):
    (
        _,
        gateway,
        repository,
        _,
        screening_commands,
        _,
    ) = _services(app_settings)
    project = screening_commands.create_project(ProjectCreate(name="Export project"))
    candidate = screening_commands.stage_candidate(
        project.id,
        CandidateCreate(
            item=BibliographicItemDraft(
                item_type="journal_article",
                title="Exported deterministically",
                identifiers=[IdentifierInput(scheme="doi", value="10.1000/exported")],
            ),
            source_provider="test",
        ),
    )
    membership = screening_commands.promote_candidate(
        project.id, candidate.id, CandidatePromotionRequest()
    )
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(PDF)
    gateway.import_pdf(
        membership.preferred_item_id,
        pdf,
        filename="paper.pdf",
        source_url=None,
    )
    web = FakeWebClient()
    engine = ZoteroSyncEngine(
        domain=gateway,
        repository=repository,
        local_client=None,
        web_client=web,
    )
    service = ZoteroTransferService(
        repository,
        engine,
        planner=ZoteroDiffPlanner(clock=lambda: NOW),
        clock=lambda: NOW,
    )
    request = TransferPreviewRequest(direction="export", library=LIBRARY, project_id=project.id)
    preview = service.create_preview(request)
    assert preview.summary.new == 1

    receipt = service.execute(
        preview.id,
        TransferExecuteRequest(confirmed=True, expected_preview_hash=preview.preview_hash),
    )

    assert receipt.status == "succeeded"
    assert web.item["data"]["title"] == "Exported deterministically"
    assert len(web.children) == 1
    assert web.uploaded_paths[0].name == "paper.pdf"
    next_preview = service.create_preview(request)
    assert next_preview.summary.unchanged == 1


class SimulatedReceiptCommitCrash(BaseException):
    pass


class CrashAfterRemoteWriteRepository(SqliteZoteroTransferRepository):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.crash_once = True

    def save_progress(self, receipt):
        if (
            self.crash_once
            and receipt.items
            and receipt.items[-1].outcome != "applying"
        ):
            self.crash_once = False
            raise SimulatedReceiptCommitCrash()
        super().save_progress(receipt)


def test_export_recovers_a_remote_write_without_creating_duplicates(app_settings, tmp_path):
    (
        database,
        gateway,
        _,
        _,
        screening_commands,
        _,
    ) = _services(app_settings)
    project = screening_commands.create_project(ProjectCreate(name="Recover export"))
    candidate = screening_commands.stage_candidate(
        project.id,
        CandidateCreate(
            item=BibliographicItemDraft(
                item_type="journal_article",
                title="Exactly once export",
                identifiers=[IdentifierInput(scheme="doi", value="10.1000/recover")],
            ),
            source_provider="test",
        ),
    )
    membership = screening_commands.promote_candidate(
        project.id, candidate.id, CandidatePromotionRequest()
    )
    pdf = tmp_path / "recover.pdf"
    pdf.write_bytes(PDF)
    gateway.import_pdf(
        membership.preferred_item_id,
        pdf,
        filename="recover.pdf",
        source_url=None,
    )
    web = FakeWebClient()
    crashing_repository = CrashAfterRemoteWriteRepository(database, clock=lambda: NOW)
    engine = ZoteroSyncEngine(
        domain=gateway,
        repository=crashing_repository,
        local_client=None,
        web_client=web,
    )
    service = ZoteroTransferService(
        crashing_repository,
        engine,
        planner=ZoteroDiffPlanner(clock=lambda: NOW),
        clock=lambda: NOW,
    )
    preview = service.create_preview(
        TransferPreviewRequest(
            direction="export", library=LIBRARY, project_id=project.id
        )
    )
    execute = TransferExecuteRequest(
        confirmed=True, expected_preview_hash=preview.preview_hash
    )

    with pytest.raises(SimulatedReceiptCommitCrash):
        service.execute(preview.id, execute)

    assert web.create_calls == 1
    assert web.attachment_create_calls == 1
    assert len(web.children) == 1

    repository = SqliteZoteroTransferRepository(database, clock=lambda: NOW)
    restarted = ZoteroTransferService(
        repository,
        ZoteroSyncEngine(
            domain=gateway,
            repository=repository,
            local_client=None,
            web_client=web,
        ),
        planner=ZoteroDiffPlanner(clock=lambda: NOW),
        clock=lambda: NOW,
    )
    assert restarted.reconcile_interrupted() == 1
    receipt = restarted.execute(preview.id, execute)

    assert receipt.status == "succeeded"
    assert web.create_calls == 1
    assert web.attachment_create_calls == 1
    assert web.attachment_upload_calls == 1
    assert len(web.children) == 1
