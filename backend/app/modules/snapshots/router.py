from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse

from app.core.dependencies import get_app_context

from .models import SnapshotOperation, SnapshotOverview, SnapshotRestoreRequest
from .service import SnapshotService

router = APIRouter(prefix="/snapshots", tags=["snapshots"])


def get_service(request: Request) -> SnapshotService:
    return get_app_context(request).snapshots


@router.get("", response_model=SnapshotOverview, summary="读取备份列表与当前操作")
def list_snapshots(
    service: Annotated[SnapshotService, Depends(get_service)],
) -> SnapshotOverview:
    return service.overview()


@router.post("", response_model=SnapshotOperation, status_code=202, summary="创建完整备份")
def create_snapshot(
    service: Annotated[SnapshotService, Depends(get_service)],
) -> SnapshotOperation:
    return service.create()


@router.get("/{filename}/download", summary="下载备份")
def download_snapshot(
    filename: str,
    service: Annotated[SnapshotService, Depends(get_service)],
) -> FileResponse:
    path = service.locate(filename)
    return FileResponse(path, filename=path.name, media_type="application/zip")


@router.post(
    "/{filename}/restore",
    response_model=SnapshotOperation,
    status_code=202,
    summary="用服务器备份恢复全部学习数据",
)
def restore_snapshot(
    filename: str,
    payload: SnapshotRestoreRequest,
    service: Annotated[SnapshotService, Depends(get_service)],
) -> SnapshotOperation:
    return service.restore(filename, payload)
