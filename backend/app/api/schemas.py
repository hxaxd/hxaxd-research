"""HTTP API schemas.

This module is the field-contract authority for the workbench backend: the
frontend's handwritten types live in `frontend/src/shared/api/contracts.ts`
and are guarded against drift from the OpenAPI schema by a contract test.
Wire fields are camelCase.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class CreateProjectRequest(CamelModel):
    name: str
    request_id: str


class BindWorkspaceRequest(CamelModel):
    workspace_id: str


class ProjectOut(CamelModel):
    id: str
    name: str
    directory: str
    workspace_id: str | None
    created_at: str
    updated_at: str


class ProjectListOut(CamelModel):
    projects: list[ProjectOut]


class HealthOut(CamelModel):
    status: str
