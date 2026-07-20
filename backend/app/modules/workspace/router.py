from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.core.dependencies import get_app_context

from .models import WorkspaceState
from .service import WorkspaceService

router = APIRouter(tags=["workspace"])


def get_service(request: Request) -> WorkspaceService:
    return get_app_context(request).workspace


@router.get(
    "/workspace",
    response_model=WorkspaceState,
    summary="读取完整学习工作区状态",
    description="一次返回全部学习项目、论文字段、筛选状态、PDF 资源和本地工具状态。",
)
def get_workspace(
    service: Annotated[WorkspaceService, Depends(get_service)],
) -> WorkspaceState:
    return service.get()
