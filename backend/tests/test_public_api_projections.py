from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.agents import AgentRunStatus, AgentSupervisor, PromptAssembler, PromptContext
from app.agents.repository import SqliteAgentRunRepository
from app.agents.router import create_agent_router
from app.agents.runtime import RuntimeOutcome, RuntimeOutcomeStatus
from app.jobs import JobCreate, JobScheduler, SqliteJobRepository
from app.jobs.router import create_job_router
from app.platform.db import V3Database
from app.platform.public_projection import sanitize_public_text


class _NoopRuntime:
    name = "noop"
    version = "1"

    def run(self, request, emit, approve, cancellation):
        return RuntimeOutcome(
            status=RuntimeOutcomeStatus.COMPLETED,
            thread_id=request.thread_id,
            turn_id=None,
        )

    def interrupt(self, run_id):
        return None


def test_public_text_redacts_forward_slash_windows_paths() -> None:
    value = "failed at C:/Users/private/AppData/Local/HxaxdResearch/runtime/agent.log"

    sanitized = sanitize_public_text(value)

    assert sanitized == "failed at [REDACTED_PATH]"


def _job_repository(tmp_path) -> SqliteJobRepository:
    database_path = tmp_path / "public-jobs.sqlite3"
    V3Database(database_path).initialize()
    repository = SqliteJobRepository(database_path)
    repository.initialize_schema()
    return repository


def test_job_api_projects_state_and_redacts_event_payloads(tmp_path) -> None:
    repository = _job_repository(tmp_path)
    scheduler = JobScheduler(repository)
    secret = "secret-download-token"
    job = scheduler.create(
        JobCreate(
            kind="attachment.download",
            input={
                "url": f"https://papers.example.test/file.pdf?token={secret}&view=full",
                "destination": r"C:\private\download.pdf",
            },
            idempotency_key=f"idempotency-{secret}",
            concurrency_key=f"concurrency-{secret}",
        )
    )
    claimed = repository.claim_next("worker-private")
    assert claimed is not None
    repository.append_event(
        job.id,
        "download.started",
        {
            "url": f"https://papers.example.test/file.pdf?token={secret}&view=full",
            "cwd": r"C:\private\workspace",
            "token": secret,
            "nested": {
                "providerThreadId": "provider-thread-private",
                "message": (
                    r"reading C:\private\workspace\paper.pdf "
                    f"with api_key={secret}"
                ),
            },
        },
        attempt_id=claimed.attempt.id,
    )
    repository.complete(
        claimed,
        {
            "download_url": f"/api/download?token={secret}",
            "path": r"C:\private\download.pdf",
        },
        [],
    )

    app = FastAPI()
    app.include_router(
        create_job_router(lambda: scheduler, lambda: repository),
        prefix="/api",
    )
    client = TestClient(app)

    public_job = client.get(f"/api/jobs/{job.id}").json()
    assert set(public_job) == {
        "id",
        "kind",
        "subject_type",
        "subject_id",
        "status",
        "priority",
        "error_code",
        "error_message",
        "max_attempts",
        "created_at",
        "updated_at",
        "started_at",
        "finished_at",
        "cancel_requested_at",
    }
    assert public_job["status"] == "succeeded"
    assert secret not in client.get("/api/jobs").text

    stream = client.get(f"/api/jobs/{job.id}/events")
    assert stream.status_code == 200
    assert secret not in stream.text
    assert "worker-private" not in stream.text
    assert "provider-thread-private" not in stream.text
    assert claimed.attempt.id not in stream.text
    assert r"C:\private" not in stream.text
    assert "https://papers.example.test/file.pdf?view=full" in stream.text

    internal = repository.get(job.id)
    assert secret in internal.input["url"]
    assert secret in internal.result["download_url"]
    assert secret in repository.list_events(job.id)[2].payload["url"]

    contract = client.get("/openapi.json").json()
    properties = contract["components"]["schemas"]["PublicJob"]["properties"]
    for private in (
        "input",
        "result",
        "idempotency_key",
        "concurrency_key",
        "lease_owner",
        "lease_expires_at",
        "heartbeat_at",
        "available_at",
    ):
        assert private not in properties


def test_public_job_error_removes_secrets_urls_and_local_paths(tmp_path) -> None:
    repository = _job_repository(tmp_path)
    job = repository.enqueue(JobCreate(kind="test.failure"))
    claimed = repository.claim_next("worker-private")
    assert claimed is not None
    secret = "credential-value"
    repository.fail(
        claimed,
        code="process_failed",
        message=(
            f"failed at https://service.test/run?q=visible&api_key={secret}; "
            r"log=C:\private\failure.log"
        ),
        retryable=False,
    )
    scheduler = JobScheduler(repository)
    app = FastAPI()
    app.include_router(
        create_job_router(lambda: scheduler, lambda: repository), prefix="/api"
    )
    client = TestClient(app)

    response = client.get(f"/api/jobs/{job.id}")
    assert response.status_code == 200
    assert secret not in response.text
    assert r"C:\private" not in response.text
    assert "q=visible" in response.json()["error_message"]
    assert secret in repository.get(job.id).error_message


def test_agent_api_redacts_runtime_ids_approval_details_and_public_events(tmp_path) -> None:
    database_path = tmp_path / "public-agents.sqlite3"
    V3Database(database_path).initialize()
    repository = SqliteAgentRunRepository(database_path)
    repository.initialize_schema()
    supervisor = AgentSupervisor(
        repository,
        _NoopRuntime(),
        PromptAssembler(),
        tmp_path / "agent-workspaces",
    )
    run = supervisor.create("literature.search", PromptContext(objective="核验论文"))
    secret = "agent-secret-token"
    repository.append_event(
        run.id,
        "web_search.started",
        {
            "id": "provider-item-private",
            "turn_id": "provider-turn-private",
            "url": f"https://search.example.test/results?q=paper&token={secret}",
            "action": {
                "command": "read private files",
                "cwd": r"C:\private\agent",
                "url": f"https://search.example.test/open?token={secret}&page=2",
            },
            "message": f"token={secret} at C:\\private\\agent\\trace.log",
        },
    )
    approval = repository.create_approval(
        run.id,
        "provider-approval-private",
        "command",
        {
            "reason": "需要用户确认",
            "command": f"tool --token={secret}",
            "cwd": r"C:\private\agent",
            "providerRequestId": "provider-request-private",
            "approvalId": "provider-approval-payload-private",
            "itemId": "provider-item-payload-private",
            "method": "item/commandExecution/requestApproval",
            "grantRoot": r"C:\private\agent",
        },
        approvable=True,
    )
    repository.transition(
        run.id,
        AgentRunStatus.FAILED,
        provider_thread_id="provider-thread-private",
        provider_turn_id="provider-turn-private",
        final_message=f"see https://result.test/?token={secret}&page=1",
        error_code="runtime_failed",
        error_message=f"token={secret} at C:\\private\\agent\\error.log",
    )

    jobs = SqliteJobRepository(database_path)
    jobs.initialize_schema()
    scheduler = JobScheduler(jobs)
    app = FastAPI()
    app.include_router(
        create_agent_router(
            lambda: supervisor,
            lambda: repository,
            lambda: scheduler,
            context_resolver=lambda request: PromptContext(objective=request.goal),
            scope_resolver=lambda request: ("catalog.read",),
        ),
        prefix="/api",
    )
    client = TestClient(app)

    public_run = client.get(f"/api/agent-runs/{run.id}")
    assert public_run.status_code == 200
    assert secret not in public_run.text
    assert "provider-thread-private" not in public_run.text
    assert "provider-turn-private" not in public_run.text
    assert r"C:\private" not in public_run.text
    assert "https://result.test/?page=1" in public_run.json()["final_message"]

    approvals = client.get(f"/api/agent-runs/{run.id}/approvals")
    assert approvals.status_code == 200
    public_approval = approvals.json()[0]
    assert public_approval["id"] == approval.id
    assert public_approval["request"] == {"reason": "需要用户确认"}
    assert "provider_request_id" not in public_approval

    stream = client.get(f"/api/agent-runs/{run.id}/events")
    assert stream.status_code == 200
    assert secret not in stream.text
    assert "provider-turn-private" not in stream.text
    assert "provider-item-private" not in stream.text
    assert "provider-request-private" not in stream.text
    assert r"C:\private" not in stream.text
    assert "https://search.example.test/results?q=paper" in stream.text
    assert "https://search.example.test/open?page=2" in stream.text

    internal_run = repository.get(run.id)
    assert internal_run.provider_thread_id == "provider-thread-private"
    assert secret in internal_run.error_message
    assert secret in repository.list_events(run.id)[1].payload["url"]
    assert repository.get_approval(approval.id).provider_request_id == (
        "provider-approval-private"
    )


def test_openapi_uses_public_job_projection_for_every_job_response(client) -> None:
    contract = client.get("/openapi.json").json()
    paths = contract["paths"]

    single_job_responses = (
        ("/api/jobs/{job_id}", "get", "200"),
        ("/api/jobs/{job_id}/cancel", "post", "202"),
        ("/api/tools/{name}/install", "post", "202"),
        ("/api/items/{item_id}/attachments/download", "post", "202"),
        ("/api/attachments/{attachment_id}/compile", "post", "202"),
        ("/api/attachments/{attachment_id}/translate", "post", "202"),
        ("/api/snapshots", "post", "202"),
        ("/api/snapshots/{filename}/restore", "post", "202"),
    )
    for path, method, status in single_job_responses:
        schema = paths[path][method]["responses"][status]["content"][
            "application/json"
        ]["schema"]
        assert schema == {"$ref": "#/components/schemas/PublicJob"}

    list_schema = paths["/api/jobs"]["get"]["responses"]["200"]["content"][
        "application/json"
    ]["schema"]
    assert list_schema["items"] == {"$ref": "#/components/schemas/PublicJob"}

    public_properties = contract["components"]["schemas"]["PublicJob"]["properties"]
    assert not {
        "input",
        "result",
        "idempotency_key",
        "concurrency_key",
        "lease_owner",
        "lease_expires_at",
        "heartbeat_at",
    }.intersection(public_properties)
