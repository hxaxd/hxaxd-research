from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.agents.repository import SqliteAgentRunRepository
from app.agents.router import create_agent_router
from app.agents.supervisor import AgentSupervisor
from app.catalog.api import router as catalog_router
from app.catalog.domain import CatalogNotFoundError
from app.changes.api import router as changes_router
from app.device_access.api import router as device_access_router
from app.documents.api import router as documents_router
from app.integrations.zotero.router import router as zotero_router
from app.integrations.zotero.service import TransferNotFoundError
from app.jobs.repository import SqliteJobRepository
from app.jobs.router import create_job_router
from app.jobs.scheduler import JobScheduler
from app.library.api import router as library_router
from app.operations.api import router as operations_router
from app.preferences.api import router as preferences_router
from app.reading.api import router as reading_router
from app.screening.api import router as screening_router
from app.screening.domain import ScreeningNotFoundError
from app.snapshots.router import create_snapshot_router
from app.snapshots.service import SnapshotService
from app.workspace.api import router as workspace_router

from .health import router as health_router


def create_api_router(context) -> APIRouter:
    def jobs(_: Request) -> JobScheduler:
        return context.jobs

    def job_repository(_: Request) -> SqliteJobRepository:
        return context.job_repository

    def agent_supervisor(_: Request) -> AgentSupervisor:
        return context.agent_supervisor

    def agent_repository(_: Request) -> SqliteAgentRunRepository:
        return context.agent_repository

    def snapshots(_: Request) -> SnapshotService:
        return context.snapshots

    def agent_defaults() -> tuple[str | None, str | None]:
        configured = context.preferences.get().agent
        return configured.model, configured.reasoning_effort

    def resolve_context(payload):
        try:
            return context.agent_prompt_context.resolve(
                task_kind=payload.task_kind,
                goal=payload.goal,
                project_id=payload.project_id,
                item_id=payload.item_id,
                target_type=(
                    "zotero_preview" if payload.zotero_preview_id is not None else None
                ),
                target_id=payload.zotero_preview_id,
            )
        except (
            CatalogNotFoundError,
            ScreeningNotFoundError,
            TransferNotFoundError,
        ) as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    def resolve_scopes(payload) -> tuple[str, ...]:
        try:
            return context.agent_prompt_context.scopes_for(
                payload.task_kind,
                payload.project_id,
                payload.item_id,
                "zotero_preview" if payload.zotero_preview_id is not None else None,
                payload.zotero_preview_id,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    router = APIRouter(prefix="/api")
    router.include_router(health_router)
    router.include_router(device_access_router)
    router.include_router(workspace_router)
    router.include_router(screening_router)
    router.include_router(catalog_router)
    router.include_router(changes_router)
    router.include_router(library_router)
    router.include_router(documents_router)
    router.include_router(operations_router)
    router.include_router(reading_router)
    router.include_router(preferences_router)
    router.include_router(create_job_router(jobs, job_repository))
    router.include_router(
        create_agent_router(
            agent_supervisor,
            agent_repository,
            jobs,
            resolve_context,
            resolve_scopes,
            agent_defaults,
        )
    )
    router.include_router(create_snapshot_router(snapshots))
    router.include_router(zotero_router)
    return router
