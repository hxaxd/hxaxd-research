from __future__ import annotations

import re
from pathlib import Path
from threading import Event
from time import sleep


def _candidate(title: str = "A Traceable Candidate") -> dict:
    return {
        "item": {
            "item_type": "journalArticle",
            "title": title,
            "abstract": "A sourced candidate.",
            "issued_year": 2026,
            "creators": [
                {
                    "creator_type": "literal",
                    "literal_name": "Ada Example",
                    "raw_name": "Ada Example",
                }
            ],
            "identifiers": [{"scheme": "doi", "value": "10.0000/traceable", "is_primary": True}],
            "links": [
                {
                    "relation_type": "landing_page",
                    "url": "https://example.org/paper",
                }
            ],
        },
        "source_provider": "crossref",
        "source_external_key": "10.0000/traceable",
        "source_url": (
            "https://api.crossref.org/works/10.0000/traceable?api_key=private"
        ),
        "raw_payload": {
            "title": title,
            "source": "fixture",
            "api_key": "private",
            "download_url": "https://example.org/paper.pdf?signature=private",
        },
        "rationale": "The user asked for this topic.",
    }


def test_candidate_review_is_atomic_and_exposes_source_evidence(client) -> None:
    project = client.post(
        "/api/projects", json={"name": "Agent Memory", "description": "Long-term memory"}
    ).json()
    staged = client.post(f"/api/projects/{project['id']}/candidates", json=_candidate())
    assert staged.status_code == 201, staged.text
    candidate = staged.json()
    assert candidate["state"] == "staged"
    assert candidate["evidence"][0]["provider"] == "crossref"
    assert candidate["evidence"][0]["fields"]["source"] == "fixture"
    assert "api_key" not in candidate["evidence"][0]["fields"]
    assert "?" not in candidate["evidence"][0]["url"]
    assert "?" not in candidate["evidence"][0]["fields"]["download_url"]

    decided = client.post(
        f"/api/projects/{project['id']}/candidate-decisions",
        json={
            "decisions": [
                {
                    "candidate_id": candidate["id"],
                    "decision": "include",
                    "reason": "Directly relevant to the project scope.",
                }
            ]
        },
    )
    assert decided.status_code == 200, decided.text
    result = decided.json()[0]
    assert result["candidate"]["state"] == "promoted"
    assert result["project_item"]["status"] == "included"

    items = client.get(f"/api/projects/{project['id']}/items").json()
    assert len(items) == 1
    assert items[0]["relevance"] == "Directly relevant to the project scope."

    workspace = client.get("/api/workspace").json()
    assert workspace["contract_version"] == "4.0"
    assert workspace["counts"]["works"] == 1
    assert workspace["counts"]["attachments"] == 0


def test_public_contract_has_no_legacy_paper_or_prompt_context_surface(client) -> None:
    contract = client.get("/openapi.json").json()
    paths = contract["paths"]
    assert "/api/projects/{project_id}/items" in paths
    assert "/api/projects/{project_id}/candidate-decisions" in paths
    assert not any("/papers" in path for path in paths)
    assert "post" not in paths["/api/jobs"]
    assert "/api/jobs/{job_id}/resume" not in paths

    create_schema = contract["components"]["schemas"]["CreateAgentRunRequest"]
    assert set(create_schema["properties"]) == {
        "task_kind",
        "goal",
            "project_id",
            "item_id",
            "zotero_preview_id",
        }
    public_run = contract["components"]["schemas"]["PublicAgentRun"]["properties"]
    for internal in ("prompt", "cwd", "context_hash", "provider_thread_id"):
        assert internal not in public_run
    public_attachment = contract["components"]["schemas"]["PublicAttachment"][
        "properties"
    ]
    assert not {"blob_id", "source_url", "storage_key"} & public_attachment.keys()
    public_tool = contract["components"]["schemas"]["PublicManagedTool"]["properties"]
    assert not {"executable_path", "install_path"} & public_tool.keys()


def test_frontend_contract_field_sets_match_openapi(client) -> None:
    schemas = client.get("/openapi.json").json()["components"]["schemas"]
    source = (
        Path(__file__).resolve().parents[2]
        / "frontend"
        / "src"
        / "shared"
        / "api"
        / "contracts.ts"
    ).read_text("utf-8")
    mappings = {
        "Capability": "RuntimeCapability",
        "Workspace": "WorkspaceProjection",
        "WorkspaceProject": "ProjectProjection",
        "Project": "ProjectView",
        "ProjectCreate": "ProjectCreate",
        "ProjectItem": "ProjectWorkView",
        "Creator": "CreatorView",
        "Identifier": "IdentifierView",
        "BibliographicLink": "LinkView",
        "BibliographicTag": "TagView",
        "BibliographicItem": "BibliographicItemView",
        "CandidateEvidence": "CandidateEvidence",
        "Candidate": "CandidateView",
        "CandidateDecision": "CandidateDecision",
        "CandidateDecisionResult": "CandidateDecisionResult",
        "Attachment": "PublicAttachment",
        "SemanticDocument": "Document",
        "DocumentBlock": "DocumentBlockView",
        "DocumentBlocksPage": "DocumentBlocksPage",
        "BlockTranslation": "BlockTranslation",
        "Job": "PublicJob",
        "AgentRun": "PublicAgentRun",
        "AgentRunCreate": "CreateAgentRunRequest",
        "AgentRunLaunch": "AgentRunLaunch",
            "Approval": "PublicApproval",
            "ChangeEvidence": "EvidenceReference",
            "ChangeItem": "ChangeItemView",
            "ChangeSet": "ChangeSetView",
            "ChangeSetList": "ChangeSetList",
            "ChangeReviewDecision": "ChangeReviewDecision",
        "TransferDifference": "FieldDifference",
        "TransferConflict": "TransferConflict",
        "TransferConflictResolution": "ConflictResolution",
        "TransferPlanItem": "PublicTransferPlanItem",
        "TransferPreview": "PublicTransferPreview",
        "TransferPreviewRequest": "TransferPreviewRequest",
        "TransferReceipt": "TransferReceipt",
        "ManagedTool": "PublicManagedTool",
        "AttachmentDownloadRequest": "AttachmentDownloadRequest",
        "SnapshotItem": "SnapshotItem",
        "SnapshotOverview": "SnapshotOverview",
        "ZoteroEndpointStatus": "ZoteroEndpointStatus",
        "ZoteroIntegrationStatus": "ZoteroIntegrationStatus",
    }

    for frontend_name, schema_name in mappings.items():
        match = re.search(
            rf"export interface {re.escape(frontend_name)}\s*\{{(.*?)^\}}",
            source,
            flags=re.MULTILINE | re.DOTALL,
        )
        assert match is not None, frontend_name
        frontend_fields = set(
            re.findall(r"^  ([A-Za-z_][A-Za-z0-9_]*)\??:", match.group(1), re.MULTILINE)
        )
        backend_fields = set(schemas[schema_name]["properties"])
        assert frontend_fields == backend_fields, frontend_name


def test_task_lists_start_empty(client) -> None:
    assert client.get("/api/jobs").json() == []
    assert client.get("/api/agent-runs").json() == []


def test_zotero_integration_is_wired_into_the_application(client) -> None:
    response = client.get("/api/zotero/status")

    assert response.status_code == 200
    assert response.json()["local"]["read_only"] is True
    assert response.json()["web"]["read_only"] is False
    assert client.app.state.zotero_service is client.app.state.context.zotero_service


def test_literature_search_requires_a_real_project_scope(client) -> None:
    missing_scope = client.post(
        "/api/agent-runs",
        json={"task_kind": "literature_search", "goal": "查找来源可靠的候选"},
    )
    assert missing_scope.status_code == 422
    assert client.get("/api/agent-runs").json() == []

    missing_project = client.post(
        "/api/agent-runs",
        json={
            "task_kind": "literature_search",
            "goal": "查找来源可靠的候选",
            "project_id": "not-a-project",
        },
    )
    assert missing_project.status_code == 404
    assert client.get("/api/agent-runs").json() == []


def test_snapshot_maintenance_blocks_writes_but_keeps_reads_available(client) -> None:
    gate = client.app.state.context.mutation_gate
    with gate.maintenance():
        blocked = client.post("/api/projects", json={"name": "Too late", "description": "blocked"})
        assert blocked.status_code == 503
        assert blocked.json()["code"] == "workspace_maintenance"
        assert client.get("/api/workspace").status_code == 200

    with gate.maintenance(block_reads=True):
        assert client.get("/api/workspace").status_code == 503
        assert client.get("/api/health").status_code == 200

    created = client.post(
        "/api/projects", json={"name": "After maintenance", "description": "ready"}
    )
    assert created.status_code == 201


def test_worker_failure_degrades_health_and_workspace_readiness(client, monkeypatch) -> None:
    context = client.app.state.context
    repository = context.job_repository
    original_claim_next = repository.claim_next
    failure_seen = Event()
    allow_recovery = Event()

    def flaky_claim_next(*args, **kwargs):
        failure_seen.set()
        if not allow_recovery.is_set():
            raise RuntimeError("job polling unavailable")
        return original_claim_next(*args, **kwargs)

    monkeypatch.setattr(repository, "claim_next", flaky_claim_next)
    context.job_worker.notify()
    assert failure_seen.wait(2)
    for _ in range(200):
        if context.job_worker.last_error is not None:
            break
        sleep(0.01)

    health = client.get("/api/health")
    assert health.status_code == 503
    assert health.json()["status"] == "degraded"
    assert health.json()["durable_jobs"]["worker_alive"] is True
    assert health.json()["durable_jobs"]["error_code"] == "job_worker_error"
    assert "job polling unavailable" not in health.text
    capability = client.get("/api/workspace").json()["capabilities"]["durable_jobs"]
    assert capability["ready"] is False
    assert capability["details"]["worker_alive"] is True
    assert capability["details"]["error_code"] == "job_worker_error"
    assert "job polling unavailable" not in str(capability)

    allow_recovery.set()
    context.job_worker.notify()
    for _ in range(200):
        if context.job_worker.last_error is None:
            break
        sleep(0.01)
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/workspace").json()["capabilities"]["durable_jobs"]["ready"]


def test_agent_mcp_requires_a_run_scoped_bearer_token(client) -> None:
    initialize = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "test-client", "version": "1"},
        },
    }
    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Host": "127.0.0.1:8000",
    }
    assert client.post("/mcp/", json=initialize, headers=headers).status_code == 401

    registry = client.app.state.context.agent_capabilities
    token = registry.issue(
        "run-test",
        project_id=None,
        scopes=frozenset({"literature:read"}),
    )
    authorized = client.post(
        "/mcp/",
        json=initialize,
        headers={**headers, "Authorization": f"Bearer {token}"},
    )
    assert authorized.status_code == 200, authorized.text
    assert authorized.json()["result"]["serverInfo"]["name"] == "hxaxd-literature"
