"""Contract test: the pinned frontend OpenAPI file must match the live schema.

The pinned file `frontend/src/shared/api/openapi.json` is the single field
contract shared with the handwritten frontend types
(`frontend/src/shared/api/contracts.ts`). Regenerate it with
`uv run python -m app.openapi` when the API intentionally changes, then
update the frontend types in the same commit.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI

from app.openapi import FRONTEND_CONTRACT_PATH


def test_openapi_contract_is_pinned(app: FastAPI) -> None:
    pinned = Path(FRONTEND_CONTRACT_PATH)
    assert pinned.is_file(), (
        "frontend/src/shared/api/openapi.json 不存在:先运行"
        " `uv run python -m app.openapi` 生成并提交"
    )
    live = json.loads(json.dumps(app.openapi()))
    expected = json.loads(pinned.read_text(encoding="utf-8"))
    assert live == expected, (
        "OpenAPI 契约漂移:运行 `uv run python -m app.openapi` 重新生成,"
        "并同步更新 frontend/src/shared/api/contracts.ts"
    )


def test_contract_fields_are_camel_case(app: FastAPI) -> None:
    schema = app.openapi()
    project_fields = set(
        schema["components"]["schemas"]["ProjectOut"]["properties"]
    )
    assert project_fields == {
        "id",
        "name",
        "directory",
        "workspaceId",
        "createdAt",
        "updatedAt",
    }
    create_fields = set(
        schema["components"]["schemas"]["CreateProjectRequest"]["properties"]
    )
    assert create_fields == {"name", "requestId"}
    bind_fields = set(
        schema["components"]["schemas"]["BindWorkspaceRequest"]["properties"]
    )
    assert bind_fields == {"workspaceId"}
