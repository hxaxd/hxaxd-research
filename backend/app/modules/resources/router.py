from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from fastapi.responses import FileResponse

from app.core.dependencies import get_app_context

from .models import (
    Resource,
    ResourceFormat,
    ResourceOrigin,
    ResourcePatch,
    ResourceRepresentation,
)
from .service import ResourceService

router = APIRouter(tags=["resources"])


def get_service(request: Request) -> ResourceService:
    return get_app_context(request).resources


@router.get("/papers/{paper_id}/resources", response_model=list[Resource])
def list_resources(
    paper_id: str, service: Annotated[ResourceService, Depends(get_service)]
) -> list[Resource]:
    return service.list_by_paper(paper_id)


@router.post("/papers/{paper_id}/resources", response_model=Resource, status_code=201)
async def upload_resource(
    paper_id: str,
    upload: Annotated[UploadFile, File()],
    service: Annotated[ResourceService, Depends(get_service)],
    format_: Annotated[ResourceFormat, Form(alias="format")],
    representation: Annotated[ResourceRepresentation, Form()] = ResourceRepresentation.ORIGINAL,
    origin: Annotated[ResourceOrigin, Form()] = ResourceOrigin.USER,
    source_url: Annotated[str | None, Form()] = None,
    preferred: Annotated[bool, Form()] = True,
) -> Resource:
    return await service.save_upload(
        paper_id,
        upload,
        format_,
        representation,
        origin,
        source_url,
        preferred,
    )


@router.get("/resources/{resource_id}/content")
def get_resource_content(
    resource_id: str,
    service: Annotated[ResourceService, Depends(get_service)],
    download: Annotated[bool, Query()] = False,
) -> FileResponse:
    resource, path = service.locate(resource_id)
    return FileResponse(
        path,
        media_type=resource.media_type,
        filename=resource.filename,
        content_disposition_type="attachment" if download else "inline",
    )


@router.patch("/resources/{resource_id}", response_model=Resource)
def patch_resource(
    resource_id: str,
    payload: ResourcePatch,
    service: Annotated[ResourceService, Depends(get_service)],
) -> Resource:
    return service.patch(resource_id, payload)
