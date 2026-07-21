from __future__ import annotations

import asyncio
from threading import Event, Lock
from time import sleep

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.jobs import (
    JobCreate,
    JobExecutionResult,
    JobRegistry,
    JobScheduler,
    JobStatus,
    JobWorker,
    SqliteJobRepository,
)
from app.jobs.router import create_job_router
from app.jobs.streaming import stream_job_events
from app.platform.db import WorkspaceDatabase


def _repository(tmp_path) -> SqliteJobRepository:
    database_path = tmp_path / "jobs.sqlite3"
    WorkspaceDatabase(database_path).initialize()
    repository = SqliteJobRepository(database_path)
    repository.initialize_schema()
    return repository


def test_job_events_are_incremental_and_queued_jobs_can_cancel_and_resume(tmp_path):
    repository = _repository(tmp_path)
    scheduler = JobScheduler(repository)
    job = scheduler.create(JobCreate(kind="test.echo", input={"value": 1}))
    assert repository.has_active_jobs()
    assert not repository.has_active_jobs(exclude_job_id=job.id)
    canceled = scheduler.cancel(job.id)
    assert canceled.status is JobStatus.CANCELED
    resumed = scheduler.resume(job.id)
    assert resumed.status is JobStatus.QUEUED
    events = repository.list_events(job.id)
    assert [event.event_type for event in events] == [
        "job.queued",
        "job.canceled",
        "job.resumed",
    ]
    assert [event.id for event in events] == sorted(event.id for event in events)
    assert repository.list_events(job.id, after=events[0].id)[0].id == events[1].id


def test_worker_completes_job_and_restart_requeues_interrupted_attempt(tmp_path):
    repository = _repository(tmp_path)
    registry = JobRegistry()
    registry.register(
        "test.echo", lambda context: JobExecutionResult(result=context.claimed.job.input)
    )
    worker = JobWorker(repository, registry, worker_id="worker-1")
    job = JobScheduler(repository).create(
        JobCreate(kind="test.echo", input={"answer": 42}, max_attempts=2)
    )
    assert worker.run_once()
    completed = repository.get(job.id)
    assert completed.status is JobStatus.SUCCEEDED
    assert completed.result == {"answer": 42}

    interrupted = JobScheduler(repository).create(JobCreate(kind="test.echo", max_attempts=2))
    assert repository.claim_next("dead-worker") is not None
    assert repository.recover_interrupted() == 1
    assert repository.get(interrupted.id).status is JobStatus.QUEUED
    assert repository.attempts(interrupted.id)[0].status.value == "interrupted"


def test_success_event_exposes_only_product_ids_and_internal_links(tmp_path):
    repository = _repository(tmp_path)
    registry = JobRegistry()

    def produce(_context):
        return JobExecutionResult(
            result={
                "document_id": "document-1",
                "attachment_ids": ["attachment-2", "attachment-1"],
                "private_receipt": "not-public",
            },
            commit_point_reached=True,
        )

    registry.register("test.product", produce)
    job = repository.enqueue(JobCreate(kind="test.product"))

    assert JobWorker(repository, registry, worker_id="worker-product").run_once()
    event = repository.list_events(job.id)[-1]

    assert event.event_type == "job.succeeded"
    assert event.payload == {
        "attachments": 2,
        "attachment_ids": ["attachment-2", "attachment-1"],
        "document_id": "document-1",
        "product_link": f"/tasks?job={job.id}",
        "products": [
            {
                "type": "attachment",
                "id": "attachment-2",
                "role": "output",
                "href": "/api/attachments/attachment-2/content",
            },
            {
                "type": "attachment",
                "id": "attachment-1",
                "role": "output",
                "href": "/api/attachments/attachment-1/content",
            },
            {
                "type": "document",
                "id": "document-1",
                "role": "structured_document",
                "href": f"/tasks?job={job.id}",
            },
        ],
    }


def test_running_job_cancellation_reaches_handler(tmp_path):
    repository = _repository(tmp_path)
    registry = JobRegistry()
    entered = Event()

    def wait_for_cancel(context):
        entered.set()
        assert context.cancellation.wait(3)
        return JobExecutionResult()

    registry.register("test.wait", wait_for_cancel)
    worker = JobWorker(repository, registry, worker_id="worker-cancel", poll_interval=0.01)
    scheduler = JobScheduler(repository, worker)
    worker.start(recover=False)
    try:
        job = scheduler.create(JobCreate(kind="test.wait"))
        assert entered.wait(2)
        scheduler.cancel(job.id)
        for _ in range(200):
            if repository.get(job.id).status is JobStatus.CANCELED:
                break
            sleep(0.01)
        assert repository.get(job.id).status is JobStatus.CANCELED
    finally:
        worker.stop()


def test_cancellation_after_a_durable_commit_finishes_truthfully(tmp_path):
    repository = _repository(tmp_path)
    registry = JobRegistry()

    def commit_then_observe_cancel(context):
        repository.request_cancel(context.claimed.job.id)
        return JobExecutionResult(
            result={"attachment_id": "already-committed"},
            commit_point_reached=True,
        )

    registry.register("test.commit", commit_then_observe_cancel)
    job = repository.enqueue(JobCreate(kind="test.commit"))

    assert JobWorker(repository, registry, worker_id="worker-commit").run_once()
    completed = repository.get(job.id)
    assert completed.status is JobStatus.SUCCEEDED
    assert completed.result == {"attachment_id": "already-committed"}
    assert [event.event_type for event in repository.list_events(job.id)][-2:] == [
        "job.cancel_too_late",
        "job.succeeded",
    ]


def test_startup_can_reconcile_a_commit_from_a_dead_worker(tmp_path):
    repository = _repository(tmp_path)
    job = repository.enqueue(JobCreate(kind="test.committed", max_attempts=1))
    claimed = repository.claim_next("dead-worker")
    assert claimed is not None

    recovered = repository.reconcile_committed(job.id, {"receipt": "durable"})

    assert recovered.status is JobStatus.SUCCEEDED
    assert recovered.result == {"receipt": "durable"}
    assert repository.attempts(job.id)[0].status.value == "succeeded"


def test_worker_survives_a_revoked_lease(tmp_path):
    repository = _repository(tmp_path)
    registry = JobRegistry()

    def revoke_own_lease(context):
        assert repository.recover_interrupted() == 1
        return JobExecutionResult()

    registry.register("test.revoke", revoke_own_lease)
    job = repository.enqueue(JobCreate(kind="test.revoke", max_attempts=2))
    worker = JobWorker(repository, registry, worker_id="worker-revoked")

    assert worker.run_once()
    assert repository.get(job.id).status is JobStatus.QUEUED


def test_worker_loop_reports_repository_errors_and_recovers(tmp_path, monkeypatch):
    repository = _repository(tmp_path)
    worker = JobWorker(
        repository,
        JobRegistry(),
        worker_id="worker-loop-health",
        poll_interval=0.01,
    )
    original_claim_next = repository.claim_next
    failure_seen = Event()
    allow_recovery = Event()

    def flaky_claim_next(*args, **kwargs):
        failure_seen.set()
        if not allow_recovery.is_set():
            raise RuntimeError("claim storage unavailable")
        return original_claim_next(*args, **kwargs)

    monkeypatch.setattr(repository, "claim_next", flaky_claim_next)
    worker.start(recover=False)
    try:
        assert failure_seen.wait(2)
        for _ in range(200):
            if worker.last_error is not None:
                break
            sleep(0.01)
        assert worker.is_alive
        assert not worker.ready
        assert "loop: RuntimeError: claim storage unavailable" in worker.last_error

        allow_recovery.set()
        worker.notify()
        for _ in range(200):
            if worker.last_error is None:
                break
            sleep(0.01)
        assert worker.ready
    finally:
        worker.stop()
    assert not worker.is_alive


def test_heartbeat_errors_are_reported_without_killing_the_worker(tmp_path, monkeypatch):
    repository = _repository(tmp_path)
    registry = JobRegistry()
    handler_entered = Event()
    release_handler = Event()
    heartbeat_failed = Event()
    allow_heartbeat = Event()

    def wait_for_release(_):
        handler_entered.set()
        assert release_handler.wait(3)
        return JobExecutionResult()

    registry.register("test.heartbeat", wait_for_release)
    original_heartbeat = repository.heartbeat

    def flaky_heartbeat(*args, **kwargs):
        if not allow_heartbeat.is_set():
            heartbeat_failed.set()
            raise RuntimeError("heartbeat storage unavailable")
        return original_heartbeat(*args, **kwargs)

    monkeypatch.setattr(repository, "heartbeat", flaky_heartbeat)
    worker = JobWorker(
        repository,
        registry,
        worker_id="worker-heartbeat-health",
        poll_interval=0.01,
        heartbeat_interval=0.01,
    )
    scheduler = JobScheduler(repository, worker)
    worker.start(recover=False)
    try:
        job = scheduler.create(JobCreate(kind="test.heartbeat"))
        assert handler_entered.wait(2)
        assert heartbeat_failed.wait(2)
        for _ in range(200):
            if worker.last_error is not None:
                break
            sleep(0.01)
        assert worker.is_alive
        assert "heartbeat:" in worker.last_error
        assert "heartbeat storage unavailable" in worker.last_error

        allow_heartbeat.set()
        for _ in range(200):
            if worker.last_error is None:
                break
            sleep(0.01)
        assert worker.ready
        release_handler.set()
        for _ in range(200):
            if repository.get(job.id).status is JobStatus.SUCCEEDED:
                break
            sleep(0.01)
        assert repository.get(job.id).status is JobStatus.SUCCEEDED
    finally:
        release_handler.set()
        worker.stop()


def test_worker_pool_applies_live_task_concurrency_limit(tmp_path):
    repository = _repository(tmp_path)
    registry = JobRegistry()
    first_started = Event()
    second_started = Event()
    release = Event()
    guard = Lock()
    state = {"active": 0, "maximum": 0, "started": 0, "limit": 1}

    def wait_for_release(_):
        with guard:
            state["active"] += 1
            state["started"] += 1
            state["maximum"] = max(state["maximum"], state["active"])
            if state["started"] == 1:
                first_started.set()
            if state["started"] == 2:
                second_started.set()
        try:
            assert release.wait(3)
            return JobExecutionResult()
        finally:
            with guard:
                state["active"] -= 1

    registry.register("test.concurrent", wait_for_release)
    worker = JobWorker(
        repository,
        registry,
        worker_id="worker-concurrency",
        poll_interval=0.01,
        max_workers=3,
        concurrency_provider=lambda: state["limit"],
    )
    scheduler = JobScheduler(repository, worker)
    jobs = [scheduler.create(JobCreate(kind="test.concurrent")) for _ in range(4)]
    worker.start(recover=False)
    try:
        assert first_started.wait(2)
        assert not second_started.wait(0.1)
        state["limit"] = 2
        worker.notify()
        assert second_started.wait(2)
        with guard:
            assert state["maximum"] == 2
        release.set()
        for _ in range(300):
            if all(repository.get(job.id).status is JobStatus.SUCCEEDED for job in jobs):
                break
            sleep(0.01)
        assert all(repository.get(job.id).status is JobStatus.SUCCEEDED for job in jobs)
        with guard:
            assert state["maximum"] == 2
    finally:
        release.set()
        worker.stop()


def test_sse_stream_closes_after_terminal_event(tmp_path):
    repository = _repository(tmp_path)
    job = repository.enqueue(JobCreate(kind="test.noop"))
    repository.request_cancel(job.id)

    async def collect():
        return [item async for item in stream_job_events(repository, job.id, poll_interval=0)]

    events = asyncio.run(collect())
    assert "event: job.queued" in events[0]
    assert "event: job.canceled" in events[1]


def test_job_router_controls_existing_jobs_without_accepting_untyped_commands(tmp_path):
    repository = _repository(tmp_path)
    scheduler = JobScheduler(repository)
    app = FastAPI()
    app.include_router(
        create_job_router(lambda: scheduler, lambda: repository),
        prefix="/api",
    )
    client = TestClient(app)

    job_id = scheduler.create(JobCreate(kind="test.noop")).id
    assert [job["id"] for job in client.get("/api/jobs").json()] == [job_id]
    assert client.post("/api/jobs", json={"kind": "snapshot.restore"}).status_code == 405
    assert client.post(f"/api/jobs/{job_id}/resume").status_code == 404
    assert client.post(f"/api/jobs/{job_id}/cancel").status_code == 202
    streamed = client.get(f"/api/jobs/{job_id}/events")
    assert streamed.status_code == 200
    assert "event: job.queued" in streamed.text
    assert "event: job.canceled" in streamed.text
