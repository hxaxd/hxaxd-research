from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from .models import IntegrityReport, WorkspaceProjection
from .service import WorkspaceProjectionService

router = APIRouter(tags=["workspace"])


def get_service(request: Request) -> WorkspaceProjectionService:
    return request.app.state.context.workspace


@router.get("/workspace", response_model=WorkspaceProjection)
def workspace(
    service: Annotated[WorkspaceProjectionService, Depends(get_service)],
) -> WorkspaceProjection:
    return service.get()


@router.get("/integrity", response_model=IntegrityReport)
def integrity(
    service: Annotated[WorkspaceProjectionService, Depends(get_service)],
    deep: Annotated[bool, Query()] = False,
) -> IntegrityReport:
    return service.integrity(deep=deep)
