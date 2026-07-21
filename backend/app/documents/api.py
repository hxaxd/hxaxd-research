from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.jobs.models import PublicJob
from app.jobs.public import project_public_job
from app.jobs.repository import JobConflictError

from .models import (
    Document,
    DocumentBlocksPage,
    DocumentExtractionRequest,
    DocumentTranslationRequest,
)
from .repository import DocumentConflictError, DocumentNotFoundError
from .service import DocumentService

router = APIRouter(tags=["documents"])


def get_service(request: Request) -> DocumentService:
    return request.app.state.context.documents


@router.get("/items/{item_id}/documents", response_model=list[Document])
def list_documents(
    item_id: str, service: Annotated[DocumentService, Depends(get_service)]
) -> list[Document]:
    return service.list_for_item(item_id)


@router.get("/documents/{document_id}", response_model=Document)
def get_document(
    document_id: str, service: Annotated[DocumentService, Depends(get_service)]
) -> Document:
    try:
        return service.get(document_id)
    except DocumentNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("/documents/{document_id}/blocks", response_model=DocumentBlocksPage)
def list_document_blocks(
    document_id: str,
    service: Annotated[DocumentService, Depends(get_service)],
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
    target_language: Annotated[str | None, Query(min_length=2, max_length=40)] = None,
) -> DocumentBlocksPage:
    try:
        return service.blocks(
            document_id,
            offset=offset,
            limit=limit,
            target_language=target_language,
        )
    except DocumentNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.post(
    "/attachments/{attachment_id}/documents", response_model=PublicJob, status_code=202
)
def extract_document(
    attachment_id: str,
    payload: DocumentExtractionRequest,
    service: Annotated[DocumentService, Depends(get_service)],
) -> PublicJob:
    try:
        return project_public_job(service.extract_attachment(attachment_id, payload))
    except JobConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (DocumentConflictError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post(
    "/documents/{document_id}/translate", response_model=PublicJob, status_code=202
)
def translate_document(
    document_id: str,
    payload: DocumentTranslationRequest,
    service: Annotated[DocumentService, Depends(get_service)],
) -> PublicJob:
    try:
        return project_public_job(service.translate_document(document_id, payload))
    except DocumentNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except JobConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (DocumentConflictError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

