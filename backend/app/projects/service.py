"""Project lifecycle: allocate a managed directory and keep the registry.

Creation is synchronous and idempotent per client request id:

- the project id is derived deterministically from the request id, so a
  retry of the same request lands on the same directory;
- no compensation system: when a step fails the client retries the same
  request id; completed artifacts (the empty directory, the registration)
  are reused, never rebuilt or deleted.

DSH workspace registration is NOT performed here: the UI plugin asks the
in-host bridge (`frontend/bridge`) to create the workspace through the
upstream registry (idempotent per canonical directory path) and then binds
the returned workspace id with `bind_workspace`.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .errors import DirectoryConflictError, ProjectValidationError
from .models import Project
from .store import ProjectStore

# uuid5 namespace constant for this application; guarantees deterministic
# project ids across processes for the same request id.
_PROJECT_NAMESPACE = uuid.UUID("6f1c0d3a-9b2e-4f8a-8d1c-5a4b3c2d1e0f")

MAX_NAME_LENGTH = 120


@dataclass(frozen=True)
class CreationResult:
    project: Project
    created: bool


def project_id_for_request(request_id: str) -> str:
    """Derive the stable project id for one client request id."""
    return uuid.uuid5(_PROJECT_NAMESPACE, f"project:{request_id}").hex


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


class ProjectService:
    def __init__(self, store: ProjectStore, projects_root: Path) -> None:
        self._store = store
        self._projects_root = projects_root

    async def create_project(self, *, name: str, request_id: str) -> CreationResult:
        """Create one project, or return the project an earlier attempt with
        the same `request_id` already produced."""
        clean_name = _clean_name(name)
        clean_request_id = request_id.strip()
        if not clean_request_id:
            raise ProjectValidationError("缺少请求标识")

        existing = self._store.find_by_request_id(clean_request_id)
        if existing is not None:
            return CreationResult(project=existing, created=False)

        project_id = project_id_for_request(clean_request_id)
        directory = self._ensure_directory(project_id)

        timestamp = now_iso()
        try:
            self._store.insert(
                project_id=project_id,
                name=clean_name,
                directory=str(directory),
                request_id=clean_request_id,
                created_at=timestamp,
                updated_at=timestamp,
            )
        except Exception:
            # Another winner claimed a unique key (retried request, reused
            # directory): return the registered row when it is the same
            # request, otherwise surface the conflict.
            existing = self._store.find_by_request_id(clean_request_id)
            if existing is not None:
                return CreationResult(project=existing, created=False)
            raise
        registered = self._store.find_by_id(project_id)
        if registered is None:  # pragma: no cover - insert just succeeded
            raise RuntimeError("project registration vanished after insert")
        return CreationResult(project=registered, created=True)

    def bind_workspace(self, project_id: str, workspace_id: str) -> Project:
        """Attach a DSH workspace id to a registered project."""
        clean_workspace_id = workspace_id.strip()
        if not _UUID_PATTERN.fullmatch(clean_workspace_id):
            raise ProjectValidationError("工作区标识格式不正确")
        project = self._store.find_by_id(project_id)
        if project is None:
            raise KeyError(project_id)
        if (
            project.workspace_id is not None
            and project.workspace_id != clean_workspace_id
        ):
            raise ProjectValidationError("项目已绑定其他工作区")
        updated = self._store.bind_workspace(
            project_id, clean_workspace_id, now_iso()
        )
        if not updated:  # pragma: no cover - row existence checked above
            raise KeyError(project_id)
        bound = self._store.find_by_id(project_id)
        if bound is None:  # pragma: no cover
            raise KeyError(project_id)
        return bound

    def get_project(self, project_id: str) -> Project:
        project = self._store.find_by_id(project_id)
        if project is None:
            raise KeyError(project_id)
        return project

    def list_projects(self) -> list[Project]:
        return self._store.list_projects()

    def _ensure_directory(self, project_id: str) -> Path:
        """Allocate the managed directory for `project_id`.

        An empty leftover directory from a failed earlier attempt is reused;
        a populated one means the path is taken by something else and the
        conflict is surfaced instead of being overwritten.
        """
        directory = self._projects_root / project_id
        if directory.exists():
            if directory.is_dir() and not any(directory.iterdir()):
                return directory
            raise DirectoryConflictError(f"项目目录已存在且非空:{directory}")
        directory.mkdir(parents=True, exist_ok=False)
        return directory


def _clean_name(name: str) -> str:
    clean_name = name.strip()
    if not clean_name:
        raise ProjectValidationError("项目名称不能为空")
    if len(clean_name) > MAX_NAME_LENGTH:
        raise ProjectValidationError(f"项目名称不能超过 {MAX_NAME_LENGTH} 个字符")
    return clean_name


_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
