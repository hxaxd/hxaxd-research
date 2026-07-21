from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from .models import JobStatus, PublicJob
from .public import project_public_job
from .repository import JobNotFoundError, SqliteJobRepository
from .scheduler import JobScheduler
from .streaming import stream_job_events


def create_job_router(
    scheduler_dependency: Callable[..., JobScheduler],
    repository_dependency: Callable[..., SqliteJobRepository],
) -> APIRouter:
    router = APIRouter(prefix="/jobs", tags=["jobs"])
    scheduler_dep = Depends(scheduler_dependency)
    repository_dep = Depends(repository_dependency)
    kind_query = Query(default=None, max_length=120)
    limit_query = Query(default=200, ge=1, le=1000)
    after_query = Query(default=0, ge=0)

    @router.get("", response_model=list[PublicJob])
    def list_jobs(
        repository: SqliteJobRepository = repository_dep,
        status: JobStatus | None = None,
        kind: str | None = kind_query,
        limit: int = limit_query,
    ) -> list[PublicJob]:
        return [
            project_public_job(job)
            for job in repository.list_jobs(status=status, kind=kind, limit=limit)
        ]

    @router.get("/{job_id}", response_model=PublicJob)
    def get_job(
        job_id: str,
        repository: SqliteJobRepository = repository_dep,
    ) -> PublicJob:
        try:
            return project_public_job(repository.get(job_id))
        except JobNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @router.post("/{job_id}/cancel", response_model=PublicJob, status_code=202)
    def cancel_job(
        job_id: str,
        scheduler: JobScheduler = scheduler_dep,
    ) -> PublicJob:
        try:
            return project_public_job(scheduler.cancel(job_id))
        except JobNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @router.get("/{job_id}/events")
    def stream_events(
        job_id: str,
        repository: SqliteJobRepository = repository_dep,
        after: int = after_query,
    ) -> StreamingResponse:
        try:
            repository.get(job_id)
        except JobNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        return StreamingResponse(
            stream_job_events(repository, job_id, after=after),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return router
