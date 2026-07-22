from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .models import AuditEventPage, DocumentGlossaryEntryView, ItemHistoryView
from .service import HistoryNotFoundError, HistoryQueryService

router = APIRouter(tags=["history"])


def get_service(request: Request) -> HistoryQueryService:
    return request.app.state.context.history


@router.get("/items/{item_id}/history", response_model=ItemHistoryView)
def item_history(
    item_id: str,
    service: Annotated[HistoryQueryService, Depends(get_service)],
) -> ItemHistoryView:
    try:
        return service.item_history(item_id)
    except HistoryNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get(
    "/documents/{document_id}/glossary",
    response_model=list[DocumentGlossaryEntryView],
)
def document_glossary(
    document_id: str,
    service: Annotated[HistoryQueryService, Depends(get_service)],
    target_language: Annotated[str | None, Query(min_length=2, max_length=40)] = None,
) -> list[DocumentGlossaryEntryView]:
    try:
        return service.document_glossary(
            document_id, target_language=target_language
        )
    except HistoryNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("/audit-events", response_model=AuditEventPage)
def audit_events(
    service: Annotated[HistoryQueryService, Depends(get_service)],
    entity_type: Annotated[str | None, Query(min_length=1, max_length=80)] = None,
    entity_id: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
    correlation_id: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AuditEventPage:
    return service.audit_events(
        entity_type=entity_type,
        entity_id=entity_id,
        correlation_id=correlation_id,
        limit=limit,
        offset=offset,
    )
