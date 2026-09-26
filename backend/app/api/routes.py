"""HTTP API routes.

Error mapping: validation failures are 422, missing projects 404, directory
conflicts 409, and unexpected project failures 500 with the operator-facing
message. Workspace binding failures surface as 409/422 so the UI can offer
a retry of the binding step alone.
"""

from __future__ import annotations

import subprocess
import sys
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, UploadFile

from ..projects.errors import (
    DirectoryConflictError,
    ProjectError,
    ProjectValidationError,
)
from ..projects.materials import AddedMaterial
from ..projects.models import Project
from ..projects.service import CreationResult, ProjectService
from .schemas import (
    AddedMaterialOut,
    BindWorkspaceRequest,
    CreateProjectRequest,
    HealthOut,
    MaterialsOut,
    ProjectListOut,
    ProjectOut,
)


def build_router(service: ProjectService) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/health")
    async def read_health() -> HealthOut:
        return HealthOut(status="ok")

    @router.post("/projects")
    async def create_project(request: CreateProjectRequest) -> ProjectOut:
        result = await _create(service, request)
        return _to_out(result.project)

    @router.get("/projects")
    async def list_projects() -> ProjectListOut:
        return ProjectListOut(
            projects=[_to_out(project) for project in service.list_projects()]
        )

    @router.get("/projects/{project_id}")
    async def read_project(project_id: str) -> ProjectOut:
        return _to_out(_get(service, project_id))

    @router.patch("/projects/{project_id}/workspace")
    async def bind_workspace(
        project_id: str, request: BindWorkspaceRequest
    ) -> ProjectOut:
        _get(service, project_id)
        return _to_out(_bind(service, project_id, request.workspace_id))

    @router.post("/projects/{project_id}/materials")
    async def add_materials(
        project_id: str,
        files: Annotated[list[UploadFile], File(min_length=1)],
    ) -> MaterialsOut:
        _get(service, project_id)
        uploads = [
            (upload.filename or "", [await upload.read()]) for upload in files
        ]
        try:
            added = service.add_materials(project_id, uploads)
        except ProjectValidationError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        except ProjectError as error:
            raise HTTPException(status_code=500, detail=str(error)) from error
        return MaterialsOut(materials=[_to_material(material) for material in added])

    @router.post("/projects/{project_id}/reveal", status_code=204)
    async def reveal_project(project_id: str) -> None:
        project = _get(service, project_id)
        _open_in_file_manager(project.directory)

    return router


async def _create(
    service: ProjectService, request: CreateProjectRequest
) -> CreationResult:
    try:
        return await service.create_project(
            name=request.name, request_id=request.request_id
        )
    except ProjectValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except DirectoryConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ProjectError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


def _get(service: ProjectService, project_id: str) -> Project:
    try:
        return service.get_project(project_id)
    except KeyError:
        raise HTTPException(
            status_code=404, detail="项目不存在或已被删除"
        ) from None


def _bind(service: ProjectService, project_id: str, workspace_id: str) -> Project:
    try:
        return service.bind_workspace(project_id, workspace_id)
    except ProjectValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except KeyError:
        raise HTTPException(
            status_code=404, detail="项目不存在或已被删除"
        ) from None


def _to_out(project: Project) -> ProjectOut:
    return ProjectOut(
        id=project.id,
        name=project.name,
        directory=project.directory,
        workspace_id=project.workspace_id,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


def _to_material(material: AddedMaterial) -> AddedMaterialOut:
    return AddedMaterialOut(
        name=material.name, size=material.size, duplicate=material.duplicate
    )


def _open_in_file_manager(directory: str) -> None:
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    try:
        subprocess.run([opener, directory], check=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as error:
        raise HTTPException(
            status_code=500, detail=f"无法打开文件夹:{error}"
        ) from error


__all__ = ["build_router"]
