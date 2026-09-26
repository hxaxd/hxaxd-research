"""Project service tests: creation idempotency, directory allocation, binding."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.projects.errors import DirectoryConflictError, ProjectValidationError
from app.projects.service import ProjectService, project_id_for_request
from app.projects.store import ProjectStore


@pytest.fixture
def service(tmp_path: Path) -> ProjectService:
    return ProjectService(
        store=ProjectStore(tmp_path / "registry.sqlite3"),
        projects_root=tmp_path / "projects",
    )


async def test_create_allocates_directory_and_registers(
    service: ProjectService, tmp_path: Path
) -> None:
    result = await service.create_project(name="论文阅读", request_id="req-1")
    assert result.created is True

    project = result.project
    expected_dir = tmp_path / "projects" / project_id_for_request("req-1")
    assert Path(project.directory) == expected_dir
    assert expected_dir.is_dir()
    assert project.name == "论文阅读"
    assert project.workspace_id is None


async def test_retry_with_same_request_id_reuses_the_project(
    service: ProjectService,
) -> None:
    first = await service.create_project(name="论文阅读", request_id="req-1")
    second = await service.create_project(name="论文阅读", request_id="req-1")

    assert second.created is False
    assert second.project.id == first.project.id
    assert second.project.directory == first.project.directory


async def test_same_name_projects_get_independent_directories(
    service: ProjectService,
) -> None:
    first = await service.create_project(name="同名项目", request_id="req-1")
    second = await service.create_project(name="同名项目", request_id="req-2")

    assert first.project.id != second.project.id
    assert first.project.directory != second.project.directory


async def test_empty_directory_left_by_a_failed_attempt_is_reused(
    service: ProjectService, tmp_path: Path
) -> None:
    project_id = project_id_for_request("req-1")
    leftover = tmp_path / "projects" / project_id
    leftover.mkdir(parents=True)

    result = await service.create_project(name="论文阅读", request_id="req-1")
    assert Path(result.project.directory) == leftover


async def test_populated_foreign_directory_is_a_conflict(
    service: ProjectService, tmp_path: Path
) -> None:
    project_id = project_id_for_request("req-1")
    occupied = tmp_path / "projects" / project_id
    occupied.mkdir(parents=True)
    (occupied / "material.pdf").write_bytes(b"%PDF-1.4 fake")

    with pytest.raises(DirectoryConflictError):
        await service.create_project(name="论文阅读", request_id="req-1")


async def test_name_and_request_id_validation(service: ProjectService) -> None:
    with pytest.raises(ProjectValidationError):
        await service.create_project(name="   ", request_id="req-1")
    with pytest.raises(ProjectValidationError):
        await service.create_project(name="x" * 121, request_id="req-1")
    with pytest.raises(ProjectValidationError):
        await service.create_project(name="论文阅读", request_id="  ")


async def test_bind_workspace_validates_and_persists(
    service: ProjectService,
) -> None:
    project = (await service.create_project(name="论文阅读", request_id="req-1")).project
    workspace_id = "3f2a1b4c-1111-2222-3333-444455556666"

    bound = service.bind_workspace(project.id, workspace_id)
    assert bound.workspace_id == workspace_id

    # Binding the same workspace again is accepted; a different one refused.
    service.bind_workspace(project.id, workspace_id)
    with pytest.raises(ProjectValidationError):
        service.bind_workspace(project.id, "aaaaaaaa-1111-2222-3333-444455556666")
    with pytest.raises(ProjectValidationError):
        service.bind_workspace(project.id, "not-a-uuid")
    with pytest.raises(KeyError):
        service.bind_workspace("missing-project", workspace_id)


def test_get_and_list_and_missing(service: ProjectService) -> None:
    assert service.list_projects() == []
    with pytest.raises(KeyError):
        service.get_project("missing")
