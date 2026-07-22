from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request

from .engine import ZoteroCapabilityUnavailableError
from .models import (
    ConflictResolution,
    PublicTransferPreview,
    TransferExecuteRequest,
    TransferPreviewRequest,
    TransferReceipt,
    ZoteroIntegrationStatus,
)
from .service import (
    BlockedTransferItemError,
    StaleTransferPreviewError,
    TransferAlreadyExecutingError,
    TransferConfirmationRequiredError,
    TransferNotFoundError,
    UnresolvedTransferConflictError,
    ZoteroApplicationService,
)

router = APIRouter(prefix="/zotero", tags=["zotero"])


def get_zotero_service(request: Request) -> ZoteroApplicationService:
    """Application wiring supplies a service; routes never construct infrastructure."""

    service = getattr(request.app.state, "zotero_service", None)
    if service is None:
        raise HTTPException(status_code=503, detail="Zotero integration is not configured")
    return service


@router.get("/status", response_model=ZoteroIntegrationStatus)
def get_zotero_status(
    service: Annotated[ZoteroApplicationService, Depends(get_zotero_service)],
) -> ZoteroIntegrationStatus:
    return service.status()


@router.post("/transfers/preview", response_model=PublicTransferPreview, status_code=201)
def create_transfer_preview(
    payload: TransferPreviewRequest,
    service: Annotated[ZoteroApplicationService, Depends(get_zotero_service)],
) -> PublicTransferPreview:
    try:
        return PublicTransferPreview.from_internal(service.create_preview(payload))
    except ZoteroCapabilityUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.get("/transfers/{preview_id}", response_model=PublicTransferPreview)
def get_transfer_preview(
    preview_id: str,
    service: Annotated[ZoteroApplicationService, Depends(get_zotero_service)],
) -> PublicTransferPreview:
    try:
        return service.get_public_preview(preview_id)
    except TransferNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.put(
    "/transfers/{preview_id}/conflicts/{conflict_id}",
    response_model=ConflictResolution,
)
def resolve_transfer_conflict(
    preview_id: str,
    conflict_id: str,
    payload: ConflictResolution,
    service: Annotated[ZoteroApplicationService, Depends(get_zotero_service)],
) -> ConflictResolution:
    if payload.conflict_id != conflict_id:
        raise HTTPException(status_code=422, detail="Conflict ID does not match the route")
    try:
        return service.resolve_conflict(preview_id, payload)
    except TransferNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except (StaleTransferPreviewError, TransferAlreadyExecutingError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.post("/transfers/{preview_id}/execute", response_model=TransferReceipt)
def execute_transfer(
    preview_id: str,
    payload: TransferExecuteRequest,
    service: Annotated[ZoteroApplicationService, Depends(get_zotero_service)],
) -> TransferReceipt:
    try:
        return service.execute(preview_id, payload)
    except TransferNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except TransferConfirmationRequiredError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except (
        StaleTransferPreviewError,
        BlockedTransferItemError,
        TransferAlreadyExecutingError,
        UnresolvedTransferConflictError,
    ) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get("/transfers/{preview_id}/receipt", response_model=TransferReceipt)
def get_transfer_receipt(
    preview_id: str,
    service: Annotated[ZoteroApplicationService, Depends(get_zotero_service)],
) -> TransferReceipt:
    try:
        return service.get_receipt(preview_id)
    except TransferNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
