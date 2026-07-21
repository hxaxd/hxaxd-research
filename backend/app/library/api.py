from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from fastapi.responses import FileResponse

from .models import (
    AttachmentOrigin,
    AttachmentPreferenceCommand,
    AttachmentType,
    LanguageMode,
    PublicAttachment,
)
from .service import AttachmentService

router = APIRouter(tags=["library"])


def get_service(request: Request) -> AttachmentService:
    return request.app.state.context.attachments


@router.get("/items/{item_id}/attachments", response_model=list[PublicAttachment])
def list_attachments(
    item_id: str, service: Annotated[AttachmentService, Depends(get_service)]
) -> list[PublicAttachment]:
    return [PublicAttachment.from_internal(item) for item in service.list_for_item(item_id)]


@router.post(
    "/items/{item_id}/attachments", response_model=PublicAttachment, status_code=201
)
async def upload_attachment(
    item_id: str,
    upload: Annotated[UploadFile, File()],
    service: Annotated[AttachmentService, Depends(get_service)],
    attachment_type: Annotated[AttachmentType, Form()] = AttachmentType.FULLTEXT,
    language_mode: Annotated[LanguageMode, Form()] = LanguageMode.ORIGINAL,
    origin: Annotated[AttachmentOrigin, Form()] = AttachmentOrigin.USER,
    source_url: Annotated[str | None, Form()] = None,
    preferred_for: Annotated[list[str] | None, Form()] = None,
) -> PublicAttachment:
    attachment = await service.upload(
        item_id,
        upload,
        attachment_type,
        language_mode,
        origin,
        source_url,
        preferred_for or [],
    )
    return PublicAttachment.from_internal(attachment)


@router.put("/items/{item_id}/attachment-preferences", response_model=PublicAttachment)
def set_attachment_preference(
    item_id: str,
    payload: AttachmentPreferenceCommand,
    service: Annotated[AttachmentService, Depends(get_service)],
) -> PublicAttachment:
    return PublicAttachment.from_internal(service.set_preference(item_id, payload))


@router.get("/attachments/{attachment_id}/content")
def attachment_content(
    attachment_id: str,
    service: Annotated[AttachmentService, Depends(get_service)],
    download: Annotated[bool, Query()] = False,
) -> FileResponse:
    attachment, path = service.locate(attachment_id)
    return FileResponse(
        path,
        media_type=attachment.media_type,
        filename=attachment.filename,
        content_disposition_type="attachment" if download else "inline",
    )
