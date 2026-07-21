from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from app.jobs.models import PublicJob
from app.jobs.public import project_public_job

from .models import SnapshotOverview, SnapshotRestoreRequest
from .service import (
    SnapshotBusyError,
    SnapshotInputError,
    SnapshotNotFoundError,
    SnapshotService,
)


def create_snapshot_router(
    service_dependency: Callable[..., SnapshotService],
) -> APIRouter:
    router = APIRouter(prefix="/snapshots", tags=["snapshots"])
    service_dep = Depends(service_dependency)

    @router.get("", response_model=SnapshotOverview, summary="列出本机快照")
    def list_snapshots(
        service: SnapshotService = service_dep,
    ) -> SnapshotOverview:
        return service.overview()

    @router.post(
        "", response_model=PublicJob, status_code=202, summary="创建完整工作区快照"
    )
    def create_snapshot(
        service: SnapshotService = service_dep,
    ) -> PublicJob:
        try:
            return project_public_job(service.create())
        except SnapshotBusyError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @router.get("/{filename}/download", summary="下载快照")
    def download_snapshot(
        filename: str,
        service: SnapshotService = service_dep,
    ) -> FileResponse:
        try:
            path = service.locate(filename)
        except SnapshotNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        return FileResponse(path, filename=path.name, media_type="application/zip")

    @router.post(
        "/{filename}/restore",
        response_model=PublicJob,
        status_code=202,
        summary="原子恢复完整工作区快照",
    )
    def restore_snapshot(
        filename: str,
        payload: SnapshotRestoreRequest,
        service: SnapshotService = service_dep,
    ) -> PublicJob:
        try:
            return project_public_job(service.restore(filename, payload))
        except SnapshotNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except SnapshotInputError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        except SnapshotBusyError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    return router
