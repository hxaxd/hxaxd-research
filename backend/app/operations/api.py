from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.jobs.models import PublicJob
from app.jobs.public import project_public_job
from app.jobs.repository import JobConflictError

from .models import (
    AttachmentDownloadRequest,
    CompileJobRequest,
    ManagedToolName,
    PublicManagedTool,
    TranslationJobRequest,
)
from .service import OperationService

router = APIRouter(tags=["operations"])


def get_service(request: Request) -> OperationService:
    return request.app.state.context.operations


@router.get("/tools", response_model=list[PublicManagedTool])
def list_tools(
    service: Annotated[OperationService, Depends(get_service)],
) -> list[PublicManagedTool]:
    return [PublicManagedTool.from_internal(tool) for tool in service.list_tools()]


@router.post("/tools/{name}/install", response_model=PublicJob, status_code=202)
def install_tool(
    name: ManagedToolName,
    service: Annotated[OperationService, Depends(get_service)],
) -> PublicJob:
    try:
        return project_public_job(service.install_tool(name))
    except JobConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.post(
    "/items/{item_id}/attachments/download", response_model=PublicJob, status_code=202
)
def download_attachment(
    item_id: str,
    payload: AttachmentDownloadRequest,
    service: Annotated[OperationService, Depends(get_service)],
    project_id: Annotated[str, Query(min_length=1)],
) -> PublicJob:
    try:
        return project_public_job(
            service.download_attachment(item_id, payload, project_id=project_id)
        )
    except JobConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post(
    "/attachments/{attachment_id}/compile", response_model=PublicJob, status_code=202
)
def compile_attachment(
    attachment_id: str,
    payload: CompileJobRequest,
    service: Annotated[OperationService, Depends(get_service)],
    project_id: Annotated[str, Query(min_length=1)],
) -> PublicJob:
    try:
        return project_public_job(
            service.compile_attachment(attachment_id, payload, project_id=project_id)
        )
    except JobConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post(
    "/attachments/{attachment_id}/translate", response_model=PublicJob, status_code=202
)
def translate_attachment(
    attachment_id: str,
    payload: TranslationJobRequest,
    service: Annotated[OperationService, Depends(get_service)],
    project_id: Annotated[str, Query(min_length=1)],
) -> PublicJob:
    try:
        return project_public_job(
            service.translate_attachment(attachment_id, payload, project_id=project_id)
        )
    except JobConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
