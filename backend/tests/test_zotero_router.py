from __future__ import annotations

from datetime import UTC, datetime

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.integrations.zotero.models import (
    BibliographicDraft,
    TransferCandidate,
    TransferDirection,
    TransferPlanRequest,
    TransferPreviewRequest,
    ZoteroEndpointStatus,
    ZoteroIntegrationStatus,
    ZoteroLibraryKind,
    ZoteroLibraryRef,
)
from app.integrations.zotero.planner import ZoteroDiffPlanner
from app.integrations.zotero.router import get_zotero_service, router


class PreviewOnlyService:
    def __init__(self):
        self.planner = ZoteroDiffPlanner(clock=lambda: datetime(2026, 7, 21, tzinfo=UTC))

    def create_preview(self, request):
        return self.planner.plan(
            TransferPlanRequest(
                **request.model_dump(mode="python"),
                items=[
                    TransferCandidate(
                        item_id="candidate-1",
                        source=BibliographicDraft(
                            item_type="journalArticle", title="Paper"
                        ),
                    )
                ],
            )
        )

    def status(self):
        return ZoteroIntegrationStatus(
            local=ZoteroEndpointStatus(
                available=True, read_only=True, message="available"
            ),
            web=ZoteroEndpointStatus(
                available=False, read_only=False, message="not configured"
            ),
            import_available=True,
            export_available=False,
        )


def _request() -> TransferPreviewRequest:
    return TransferPreviewRequest(
        direction=TransferDirection.IMPORT,
        library=ZoteroLibraryRef(kind=ZoteroLibraryKind.USER, id="0"),
        project_id="project-1",
    )


def test_router_requires_application_wiring_and_accepts_an_abstract_service():
    app = FastAPI()
    app.include_router(router, prefix="/api")
    client = TestClient(app)

    unavailable = client.post(
        "/api/zotero/transfers/preview", json=_request().model_dump(mode="json")
    )
    assert unavailable.status_code == 503

    app.dependency_overrides[get_zotero_service] = PreviewOnlyService
    forged = _request().model_dump(mode="json")
    forged["items"] = [{"item_id": "frontend-controlled", "fingerprint": "fake"}]
    rejected = client.post("/api/zotero/transfers/preview", json=forged)
    assert rejected.status_code == 422

    created = client.post("/api/zotero/transfers/preview", json=_request().model_dump(mode="json"))

    assert created.status_code == 201
    assert created.json()["summary"]["new"] == 1
    assert len(created.json()["preview_hash"]) == 64
    assert "source" not in created.json()["items"][0]
    assert created.json()["items"][0]["display_title"] == "Paper"
    assert created.json()["project_id"] == "project-1"
    assert created.json()["library"] == {"kind": "users", "id": "0"}

    status = client.get("/api/zotero/status")
    assert status.json()["import_available"] is True
    assert status.json()["export_available"] is False
