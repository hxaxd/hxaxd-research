from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from .models import (
    Annotation,
    AnnotationCreate,
    AnnotationUpdate,
    ReadingBookmarkCreate,
    ReadingState,
    ReadingStateUpdate,
)
from .repository import ReadingConflictError, ReadingNotFoundError
from .service import ReadingService

router = APIRouter(tags=["reading"])


def get_service(request: Request) -> ReadingService:
    return request.app.state.context.reading


def _raise_http(error: Exception) -> None:
    if isinstance(error, ReadingNotFoundError):
        raise HTTPException(status_code=404, detail=str(error)) from error
    if isinstance(error, ReadingConflictError):
        raise HTTPException(status_code=409, detail=str(error)) from error
    raise error


@router.get(
    "/projects/{project_id}/items/{item_id}/annotations",
    response_model=list[Annotation],
)
def list_annotations(
    project_id: str,
    item_id: str,
    service: Annotated[ReadingService, Depends(get_service)],
) -> list[Annotation]:
    try:
        return service.annotations(project_id, item_id)
    except (ReadingNotFoundError, ReadingConflictError) as error:
        _raise_http(error)


@router.post(
    "/projects/{project_id}/items/{item_id}/annotations",
    response_model=Annotation,
    status_code=201,
)
def create_annotation(
    project_id: str,
    item_id: str,
    payload: AnnotationCreate,
    service: Annotated[ReadingService, Depends(get_service)],
) -> Annotation:
    try:
        return service.create_annotation(project_id, item_id, payload)
    except (ReadingNotFoundError, ReadingConflictError) as error:
        _raise_http(error)


@router.put("/annotations/{annotation_id}", response_model=Annotation)
def update_annotation(
    annotation_id: str,
    payload: AnnotationUpdate,
    service: Annotated[ReadingService, Depends(get_service)],
) -> Annotation:
    try:
        return service.update_annotation(annotation_id, payload)
    except (ReadingNotFoundError, ReadingConflictError) as error:
        _raise_http(error)


@router.delete("/annotations/{annotation_id}", status_code=204)
def delete_annotation(
    annotation_id: str,
    expected_updated_at: Annotated[datetime, Query()],
    service: Annotated[ReadingService, Depends(get_service)],
) -> Response:
    try:
        service.delete_annotation(annotation_id, expected_updated_at)
    except (ReadingNotFoundError, ReadingConflictError) as error:
        _raise_http(error)
    return Response(status_code=204)


@router.get(
    "/projects/{project_id}/items/{item_id}/reading-state",
    response_model=ReadingState,
)
def get_reading_state(
    project_id: str,
    item_id: str,
    service: Annotated[ReadingService, Depends(get_service)],
) -> ReadingState:
    try:
        return service.state(project_id, item_id)
    except (ReadingNotFoundError, ReadingConflictError) as error:
        _raise_http(error)


@router.put(
    "/projects/{project_id}/items/{item_id}/reading-state",
    response_model=ReadingState,
)
def update_reading_state(
    project_id: str,
    item_id: str,
    payload: ReadingStateUpdate,
    service: Annotated[ReadingService, Depends(get_service)],
) -> ReadingState:
    try:
        return service.update_state(project_id, item_id, payload)
    except (ReadingNotFoundError, ReadingConflictError) as error:
        _raise_http(error)


@router.post(
    "/projects/{project_id}/items/{item_id}/reading-state/bookmarks",
    response_model=ReadingState,
)
def add_reading_bookmark(
    project_id: str,
    item_id: str,
    payload: ReadingBookmarkCreate,
    service: Annotated[ReadingService, Depends(get_service)],
) -> ReadingState:
    try:
        return service.add_bookmark(project_id, item_id, payload)
    except (ReadingNotFoundError, ReadingConflictError) as error:
        _raise_http(error)


@router.delete(
    "/projects/{project_id}/items/{item_id}/reading-state/bookmarks/{bookmark_id}",
    response_model=ReadingState,
)
def delete_reading_bookmark(
    project_id: str,
    item_id: str,
    bookmark_id: str,
    service: Annotated[ReadingService, Depends(get_service)],
) -> ReadingState:
    try:
        return service.delete_bookmark(project_id, item_id, bookmark_id)
    except (ReadingNotFoundError, ReadingConflictError) as error:
        _raise_http(error)

