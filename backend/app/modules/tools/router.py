from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.core.dependencies import get_app_context

from .models import ManagedTool, ToolName
from .service import ToolService

router = APIRouter(prefix="/tools", tags=["tools"])


def get_service(request: Request) -> ToolService:
    return get_app_context(request).tools


@router.get("", response_model=list[ManagedTool], summary="读取全部本地工具状态")
def list_tools(
    service: Annotated[ToolService, Depends(get_service)],
) -> list[ManagedTool]:
    return service.list()


@router.get("/{name}", response_model=ManagedTool, summary="读取一个本地工具状态")
def get_tool(
    name: ToolName,
    service: Annotated[ToolService, Depends(get_service)],
) -> ManagedTool:
    return service.get(name)


@router.post(
    "/{name}/install",
    response_model=ManagedTool,
    status_code=202,
    summary="在固定目录中安装工具",
)
def install_tool(
    name: ToolName,
    service: Annotated[ToolService, Depends(get_service)],
) -> ManagedTool:
    return service.install(name)
