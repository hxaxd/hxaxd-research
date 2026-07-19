from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.core.dependencies import get_app_context

from .models import Paper, PaperBatchCreate, PaperBatchResult, PaperPatch
from .service import PaperService

router = APIRouter(tags=["papers"])


def get_service(request: Request) -> PaperService:
    return get_app_context(request).papers


@router.get("/schema/paper")
def paper_schema(service: Annotated[PaperService, Depends(get_service)]) -> dict:
    return service.schema()


@router.get("/projects/{project_id}/papers", response_model=list[Paper])
def list_papers(
    project_id: str,
    service: Annotated[PaperService, Depends(get_service)],
) -> list[Paper]:
    return service.list_by_project(project_id)


@router.post(
    "/projects/{project_id}/papers/batch",
    response_model=PaperBatchResult,
    status_code=201,
)
def create_papers(
    project_id: str,
    payload: PaperBatchCreate,
    service: Annotated[PaperService, Depends(get_service)],
) -> PaperBatchResult:
    return PaperBatchResult(created=service.create_many(project_id, payload))


@router.get("/papers/{paper_id}", response_model=Paper)
def get_paper(
    paper_id: str,
    service: Annotated[PaperService, Depends(get_service)],
) -> Paper:
    return service.get(paper_id)


@router.patch("/papers/{paper_id}", response_model=Paper)
def patch_paper(
    paper_id: str,
    payload: PaperPatch,
    service: Annotated[PaperService, Depends(get_service)],
) -> Paper:
    return service.patch(paper_id, payload)
