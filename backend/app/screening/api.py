from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from app.catalog.api import get_workspace_database
from app.platform.db import WorkspaceDatabase

from .commands import ScreeningCommands
from .domain import (
    CandidateState,
    ProjectWorkStatus,
    ScreeningConflictError,
    ScreeningNotFoundError,
)
from .models import (
    CandidateCreate,
    CandidateDecisionBatch,
    CandidateDecisionResult,
    CandidatePage,
    CandidateView,
    ProjectCreate,
    ProjectView,
    ProjectWorkDecision,
    ProjectWorkPage,
    ProjectWorkView,
)
from .queries import ScreeningQueries

router = APIRouter(tags=["screening"])


def get_queries(
    database: Annotated[WorkspaceDatabase, Depends(get_workspace_database)],
) -> ScreeningQueries:
    return ScreeningQueries(database)


def get_commands(
    database: Annotated[WorkspaceDatabase, Depends(get_workspace_database)],
) -> ScreeningCommands:
    return ScreeningCommands(database)


def _raise_http(error: Exception) -> None:
    if isinstance(error, ScreeningNotFoundError):
        raise HTTPException(status_code=404, detail=str(error)) from error
    if isinstance(error, ScreeningConflictError):
        raise HTTPException(status_code=409, detail=str(error)) from error
    raise error


@router.get("/projects", response_model=list[ProjectView])
def list_projects(
    queries: Annotated[ScreeningQueries, Depends(get_queries)],
) -> list[ProjectView]:
    return queries.list_projects()


@router.post("/projects", response_model=ProjectView, status_code=201)
def create_project(
    payload: ProjectCreate,
    commands: Annotated[ScreeningCommands, Depends(get_commands)],
) -> ProjectView:
    try:
        return commands.create_project(payload)
    except (ScreeningConflictError, ScreeningNotFoundError) as error:
        _raise_http(error)


@router.get("/projects/{project_id}", response_model=ProjectView)
def get_project(
    project_id: str,
    queries: Annotated[ScreeningQueries, Depends(get_queries)],
) -> ProjectView:
    try:
        return queries.get_project(project_id)
    except ScreeningNotFoundError as error:
        _raise_http(error)


@router.get("/projects/{project_id}/items", response_model=ProjectWorkPage)
def list_project_works(
    project_id: str,
    queries: Annotated[ScreeningQueries, Depends(get_queries)],
    status: ProjectWorkStatus | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ProjectWorkPage:
    try:
        return queries.list_project_works(project_id, status=status, limit=limit, offset=offset)
    except ScreeningNotFoundError as error:
        _raise_http(error)


@router.post(
    "/projects/{project_id}/candidate-decisions",
    response_model=list[CandidateDecisionResult],
)
def decide_candidates(
    project_id: str,
    payload: CandidateDecisionBatch,
    commands: Annotated[ScreeningCommands, Depends(get_commands)],
) -> list[CandidateDecisionResult]:
    try:
        return commands.decide_candidates(project_id, payload.decisions)
    except (ScreeningConflictError, ScreeningNotFoundError) as error:
        _raise_http(error)


@router.patch("/projects/{project_id}/works/{work_id}", response_model=ProjectWorkView)
def decide_project_work(
    project_id: str,
    work_id: str,
    payload: ProjectWorkDecision,
    commands: Annotated[ScreeningCommands, Depends(get_commands)],
) -> ProjectWorkView:
    try:
        return commands.decide_project_work(project_id, work_id, payload)
    except (ScreeningConflictError, ScreeningNotFoundError) as error:
        _raise_http(error)


@router.get("/projects/{project_id}/candidates", response_model=CandidatePage)
def list_candidates(
    project_id: str,
    queries: Annotated[ScreeningQueries, Depends(get_queries)],
    state: CandidateState | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> CandidatePage:
    try:
        return queries.list_candidates(project_id, state=state, limit=limit, offset=offset)
    except ScreeningNotFoundError as error:
        _raise_http(error)


@router.post("/projects/{project_id}/candidates", response_model=CandidateView, status_code=201)
def stage_candidate(
    project_id: str,
    payload: CandidateCreate,
    commands: Annotated[ScreeningCommands, Depends(get_commands)],
) -> CandidateView:
    try:
        return commands.stage_candidate(project_id, payload)
    except (ScreeningConflictError, ScreeningNotFoundError) as error:
        _raise_http(error)
