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
    summary="读取紧凑学习工作区状态",
    description="返回项目摘要、契约版本、资源能力和本地工具状态。",
)
def get_workspace(
    service: Annotated[WorkspaceService, Depends(get_service)],
) -> WorkspaceState:
    return service.get()
