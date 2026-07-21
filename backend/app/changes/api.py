from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .domain import ChangeSetConflictError, ChangeSetNotFoundError
from .models import (
    ChangeSetApplyRequest,
    ChangeSetCreate,
    ChangeSetList,
    ChangeSetReviewRequest,
    ChangeSetStatus,
    ChangeSetView,
)
from .service import ChangeSetService

router = APIRouter(prefix="/change-sets", tags=["changes"])


def get_service(request: Request) -> ChangeSetService:
    return request.app.state.context.changes


def _raise_http(error: Exception) -> None:
    if isinstance(error, ChangeSetNotFoundError):
        raise HTTPException(status_code=404, detail=str(error)) from error
    if isinstance(error, ChangeSetConflictError):
        raise HTTPException(status_code=409, detail=str(error)) from error
    raise error


@router.get("", response_model=ChangeSetList)
def list_change_sets(
    service: Annotated[ChangeSetService, Depends(get_service)],
    status: ChangeSetStatus | None = None,
    project_id: str | None = None,
    item_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ChangeSetList:
    return service.list(
        status=status,
        project_id=project_id,
        item_id=item_id,
        limit=limit,
        offset=offset,
    )


@router.post("", response_model=ChangeSetView, status_code=201)
def propose_change_set(
    payload: ChangeSetCreate,
    service: Annotated[ChangeSetService, Depends(get_service)],
) -> ChangeSetView:
    try:
        return service.propose(payload, actor_type="user", actor_id="local-user")
    except (ChangeSetConflictError, ChangeSetNotFoundError) as error:
        _raise_http(error)


@router.get("/{change_set_id}", response_model=ChangeSetView)
def get_change_set(
    change_set_id: str,
    service: Annotated[ChangeSetService, Depends(get_service)],
) -> ChangeSetView:
    try:
        return service.get(change_set_id)
    except ChangeSetNotFoundError as error:
        _raise_http(error)


@router.post("/{change_set_id}/review", response_model=ChangeSetView)
def review_change_set(
    change_set_id: str,
    payload: ChangeSetReviewRequest,
    service: Annotated[ChangeSetService, Depends(get_service)],
) -> ChangeSetView:
    try:
        return service.review(change_set_id, payload)
    except (ChangeSetConflictError, ChangeSetNotFoundError) as error:
        _raise_http(error)


@router.post("/{change_set_id}/apply", response_model=ChangeSetView)
def apply_change_set(
    change_set_id: str,
    payload: ChangeSetApplyRequest,
    service: Annotated[ChangeSetService, Depends(get_service)],
) -> ChangeSetView:
    try:
        return service.apply(change_set_id, payload)
    except (ChangeSetConflictError, ChangeSetNotFoundError) as error:
        _raise_http(error)
