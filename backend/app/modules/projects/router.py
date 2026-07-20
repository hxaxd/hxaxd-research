from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.core.dependencies import get_app_context

from .models import Project, ProjectCreate, ProjectPatch, ProjectSummary
from .service import ProjectService

router = APIRouter(prefix="/projects", tags=["projects"])


def get_service(request: Request) -> ProjectService:
    return get_app_context(request).projects


@router.get("", response_model=list[ProjectSummary])
def list_projects(
    service: Annotated[ProjectService, Depends(get_service)],
) -> list[ProjectSummary]:
    return service.list()


@router.post("", response_model=Project, status_code=201)
def create_project(
    payload: ProjectCreate,
    service: Annotated[ProjectService, Depends(get_service)],
) -> Project:
    return service.create(payload)


@router.get("/{project_id}", response_model=Project)
def get_project(
    project_id: str,
    service: Annotated[ProjectService, Depends(get_service)],
) -> Project:
    return service.get(project_id)


@router.patch("/{project_id}", response_model=Project)
def patch_project(
    project_id: str,
    payload: ProjectPatch,
    service: Annotated[ProjectService, Depends(get_service)],
) -> Project:
    return service.patch(project_id, payload)
