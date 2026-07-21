from __future__ import annotations

from collections.abc import Callable
from contextlib import suppress

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from app.jobs import JobConflictError, JobCreate, JobScheduler

from .job_handler import AGENT_RUN_JOB_KIND
from .models import (
    AgentRun,
    AgentRunStatus,
    ApprovalDecision,
    PublicAgentRun,
    PublicAgentTaskDefinition,
    PublicApproval,
)
from .prompting import PromptContext
from .public import project_public_approval, project_public_run
from .repository import AgentConflictError, AgentNotFoundError, SqliteAgentRunRepository
from .streaming import stream_agent_events
from .supervisor import AgentSupervisor


class CreateAgentRunRequest(BaseModel):
    task_kind: str = Field(min_length=1, max_length=120)
    goal: str = Field(min_length=1, max_length=20_000)
    project_id: str | None = Field(default=None, max_length=200)
    item_id: str | None = Field(default=None, max_length=200)
    zotero_preview_id: str | None = Field(default=None, max_length=200)

    @field_validator("task_kind", "goal")
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("value must contain non-whitespace characters")
        return stripped


class AgentRunLaunch(BaseModel):
    run: PublicAgentRun
    job_id: str


def create_agent_router(
    supervisor_dependency: Callable[..., AgentSupervisor],
    repository_dependency: Callable[..., SqliteAgentRunRepository],
    scheduler_dependency: Callable[..., JobScheduler],
    context_resolver: Callable[[CreateAgentRunRequest], PromptContext],
    scope_resolver: Callable[[CreateAgentRunRequest], tuple[str, ...]],
    run_defaults: Callable[[], tuple[str | None, str | None]] | None = None,
    task_definitions: Callable[[], list[PublicAgentTaskDefinition]] | None = None,
) -> APIRouter:
    """Builds the public control plane around trusted, server-side context resolvers."""

    router = APIRouter()
    runs = APIRouter(prefix="/agent-runs", tags=["agent-runs"])
    approvals = APIRouter(prefix="/approvals", tags=["agent-runs"])
    supervisor_dep = Depends(supervisor_dependency)
    repository_dep = Depends(repository_dependency)
    scheduler_dep = Depends(scheduler_dependency)
    project_query = Query(default=None, max_length=200)
    limit_query = Query(default=200, ge=1, le=1000)
    after_query = Query(default=0, ge=0)

    @router.get(
        "/agent-task-definitions", response_model=list[PublicAgentTaskDefinition]
    )
    def list_task_definitions() -> list[PublicAgentTaskDefinition]:
        return task_definitions() if task_definitions is not None else []

    def enqueue(
        scheduler: JobScheduler,
        repository: SqliteAgentRunRepository,
        run: AgentRun,
    ) -> AgentRunLaunch:
        repository.append_event(run.id, "run.enqueue_requested", {})
        try:
            job = scheduler.create(
                JobCreate(
                    kind=AGENT_RUN_JOB_KIND,
                    input={"run_id": run.id},
                    subject_type="agent_run",
                    subject_id=run.id,
                    concurrency_key=f"agent-run:{run.id}",
                )
            )
        except Exception as error:
            with suppress(AgentConflictError):
                repository.transition(
                    run.id,
                    AgentRunStatus.FAILED,
                    error_code="agent_job_enqueue_failed",
                    error_message=str(error)[-4000:],
                )
            raise
        return AgentRunLaunch(run=project_public_run(run), job_id=job.id)

    @runs.post("", response_model=AgentRunLaunch, status_code=202)
    def create_run(
        payload: CreateAgentRunRequest,
        supervisor: AgentSupervisor = supervisor_dep,
        repository: SqliteAgentRunRepository = repository_dep,
        scheduler: JobScheduler = scheduler_dep,
    ) -> AgentRunLaunch:
        context = context_resolver(payload)
        if context.objective != payload.goal:
            raise RuntimeError("agent context resolver changed the user-visible goal")
        tool_scopes = scope_resolver(payload)
        model, reasoning_effort = run_defaults() if run_defaults is not None else (None, None)
        run = supervisor.create(
            payload.task_kind,
            context,
            project_id=payload.project_id,
            item_id=payload.item_id,
            target_type=(
                "zotero_preview" if payload.zotero_preview_id is not None else None
            ),
            target_id=payload.zotero_preview_id,
            tool_scopes=tool_scopes,
            model=model,
            reasoning_effort=reasoning_effort,
        )
        try:
            return enqueue(scheduler, repository, run)
        except JobConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @runs.get("", response_model=list[PublicAgentRun])
    def list_runs(
        repository: SqliteAgentRunRepository = repository_dep,
        project_id: str | None = project_query,
        status: AgentRunStatus | None = None,
        limit: int = limit_query,
    ) -> list[PublicAgentRun]:
        return [
            project_public_run(run)
            for run in repository.list_runs(
                project_id=project_id,
                status=status,
                limit=limit,
            )
        ]

    @runs.get("/{run_id}", response_model=PublicAgentRun)
    def get_run(
        run_id: str,
        repository: SqliteAgentRunRepository = repository_dep,
    ) -> PublicAgentRun:
        try:
            return project_public_run(repository.get(run_id))
        except AgentNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @runs.post("/{run_id}/interrupt", response_model=PublicAgentRun, status_code=202)
    def interrupt_run(
        run_id: str,
        supervisor: AgentSupervisor = supervisor_dep,
        scheduler: JobScheduler = scheduler_dep,
    ) -> PublicAgentRun:
        try:
            run = supervisor.cancel(run_id)
            for job in scheduler.repository.active_for_subject("agent_run", run_id):
                scheduler.cancel(job.id)
            return project_public_run(run)
        except AgentNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @runs.post("/{run_id}/resume", response_model=AgentRunLaunch, status_code=202)
    def resume_run(
        run_id: str,
        supervisor: AgentSupervisor = supervisor_dep,
        repository: SqliteAgentRunRepository = repository_dep,
        scheduler: JobScheduler = scheduler_dep,
    ) -> AgentRunLaunch:
        try:
            run = supervisor.prepare_resume(run_id)
            return enqueue(scheduler, repository, run)
        except AgentNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except (AgentConflictError, JobConflictError) as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @runs.get("/{run_id}/events")
    def stream_events(
        run_id: str,
        repository: SqliteAgentRunRepository = repository_dep,
        after: int = after_query,
    ) -> StreamingResponse:
        try:
            repository.get(run_id)
        except AgentNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        return StreamingResponse(
            stream_agent_events(repository, run_id, after=after),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @runs.get("/{run_id}/approvals", response_model=list[PublicApproval])
    def pending_approvals(
        run_id: str,
        repository: SqliteAgentRunRepository = repository_dep,
    ) -> list[PublicApproval]:
        try:
            return [
                project_public_approval(item)
                for item in repository.pending_approvals(run_id)
            ]
        except AgentNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    def resolve_approval(
        approval_id: str,
        decision: ApprovalDecision,
        supervisor: AgentSupervisor,
    ) -> PublicApproval:
        try:
            return project_public_approval(
                supervisor.resolve_approval(approval_id, decision)
            )
        except AgentNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except AgentConflictError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @approvals.post("/{approval_id}/approve", response_model=PublicApproval)
    def approve_request(
        approval_id: str,
        supervisor: AgentSupervisor = supervisor_dep,
    ) -> PublicApproval:
        return resolve_approval(approval_id, ApprovalDecision.APPROVE, supervisor)

    @approvals.post("/{approval_id}/reject", response_model=PublicApproval)
    def reject_request(
        approval_id: str,
        supervisor: AgentSupervisor = supervisor_dep,
    ) -> PublicApproval:
        return resolve_approval(approval_id, ApprovalDecision.DENY, supervisor)

    router.include_router(runs)
    router.include_router(approvals)
    return router
