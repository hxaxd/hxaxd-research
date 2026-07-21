from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from app.catalog.models import BibliographicItemDraft
from app.catalog.queries import CatalogQueries
from app.screening.commands import ScreeningCommands
from app.screening.domain import CandidateState
from app.screening.models import CandidateCreate
from app.screening.queries import ScreeningQueries
from app.workspace.service import WorkspaceProjectionService

from .capabilities import AgentCapabilityRegistry

READ_SCOPE = "literature:read"
STAGE_SCOPE = "candidates:stage"


class AgentToolPermissionError(PermissionError):
    pass


@dataclass(frozen=True)
class _Caller:
    run_id: str
    project_id: str | None
    scopes: frozenset[str]


class AgentToolFacade:
    """Auditable domain-tool boundary; it never exposes a database handle."""

    def __init__(
        self,
        workspace: WorkspaceProjectionService,
        catalog: CatalogQueries,
        screening_queries: ScreeningQueries,
        screening_commands: ScreeningCommands,
    ) -> None:
        self.workspace = workspace
        self.catalog = catalog
        self.screening_queries = screening_queries
        self.screening_commands = screening_commands

    def workspace_summary(self, caller: _Caller) -> dict[str, Any]:
        self._require(caller, READ_SCOPE)
        projection = self.workspace.get()
        payload = projection.model_dump(mode="json")
        if caller.project_id is not None:
            payload["projects"] = [
                project
                for project in payload["projects"]
                if project["id"] == caller.project_id
            ]
        return payload

    def project(self, caller: _Caller, project_id: str | None = None) -> dict[str, Any]:
        self._require(caller, READ_SCOPE)
        resolved = self._project(caller, project_id)
        return self.screening_queries.get_project(resolved).model_dump(mode="json")

    def project_works(
        self,
        caller: _Caller,
        project_id: str | None = None,
        status: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        self._require(caller, READ_SCOPE)
        resolved = self._project(caller, project_id)
        return [
            item.model_dump(mode="json")
            for item in self.screening_queries.list_project_works(
                resolved, status=status, limit=limit, offset=offset
            )
        ]

    def item(self, caller: _Caller, item_id: str) -> dict[str, Any]:
        self._require(caller, READ_SCOPE)
        item = (
            self.catalog.get_project_item(caller.project_id, item_id)
            if caller.project_id is not None
            else self.catalog.get_item(item_id)
        )
        return item.model_dump(mode="json")

    def candidates(
        self,
        caller: _Caller,
        project_id: str | None = None,
        state: CandidateState | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        self._require(caller, READ_SCOPE)
        resolved = self._project(caller, project_id)
        return [
            candidate.model_dump(mode="json")
            for candidate in self.screening_queries.list_candidates(
                resolved, state=state, limit=limit, offset=offset
            )
        ]

    def stage_candidate(
        self,
        caller: _Caller,
        item: BibliographicItemDraft,
        *,
        project_id: str | None = None,
        source_provider: str,
        source_external_key: str | None = None,
        source_url: str | None = None,
        source_schema_version: str | None = None,
        raw_payload: dict[str, Any] | None = None,
        rank: float | None = None,
        rationale: str | None = None,
    ) -> dict[str, Any]:
        self._require(caller, STAGE_SCOPE)
        resolved = self._project(caller, project_id)
        candidate = self.screening_commands.stage_candidate(
            resolved,
            CandidateCreate(
                item=item,
                source_provider=source_provider,
                source_external_key=source_external_key,
                source_url=source_url,
                source_schema_version=source_schema_version,
                raw_payload=raw_payload,
                rank=rank,
                rationale=rationale,
            ),
            actor_type="agent",
            actor_id=caller.run_id,
            correlation_id=caller.run_id,
        )
        return candidate.model_dump(mode="json")

    @staticmethod
    def _require(caller: _Caller, scope: str) -> None:
        if scope not in caller.scopes:
            raise AgentToolPermissionError(f"agent run lacks scope: {scope}")

    @staticmethod
    def _project(caller: _Caller, requested: str | None) -> str:
        if caller.project_id is not None:
            if requested is not None and requested != caller.project_id:
                raise AgentToolPermissionError("agent run is bound to a different project")
            return caller.project_id
        if requested is None:
            raise AgentToolPermissionError("project_id is required for an unbound run")
        return requested


def create_agent_mcp_server(
    facade: AgentToolFacade,
    registry: AgentCapabilityRegistry,
    *,
    public_base_url: str,
) -> FastMCP:
    base = public_base_url.rstrip("/")
    server = FastMCP(
        "hxaxd-literature",
        instructions=(
            "Use these tools to inspect the literature workspace and stage candidates. "
            "Screening decisions are intentionally unavailable: only the user can make them."
        ),
        token_verifier=registry,
        auth=AuthSettings(
            issuer_url=f"{base}/local-agent-authority",
            resource_server_url=f"{base}/mcp",
            required_scopes=[],
        ),
        streamable_http_path="/",
        stateless_http=True,
        json_response=True,
    )

    @server.tool(
        name="workspace_summary",
        description="Return the current project-scoped workspace summary and capabilities.",
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    def workspace_summary() -> dict[str, Any]:
        return facade.workspace_summary(_caller())

    @server.tool(
        name="get_project",
        description="Return one project's metadata and counts.",
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    def get_project(project_id: str | None = None) -> dict[str, Any]:
        return facade.project(_caller(), project_id)

    @server.tool(
        name="list_project_works",
        description="List indexed works in the granted project, optionally filtered by status.",
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    def list_project_works(
        project_id: str | None = None,
        status: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        return facade.project_works(_caller(), project_id, status, limit, offset)

    @server.tool(
        name="get_bibliographic_item",
        description="Return normalized bibliographic metadata, identifiers, creators, and links.",
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    def get_bibliographic_item(item_id: str) -> dict[str, Any]:
        return facade.item(_caller(), item_id)

    @server.tool(
        name="list_candidates",
        description="List staged or matched candidates awaiting user review.",
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    def list_candidates(
        project_id: str | None = None,
        state: CandidateState | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        return facade.candidates(_caller(), project_id, state, limit, offset)

    @server.tool(
        name="stage_candidate",
        description=(
            "Stage a sourced bibliographic candidate for user review. This never includes, "
            "excludes, dismisses, promotes, or deletes a work."
        ),
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=False,
            openWorldHint=False,
        ),
    )
    def stage_candidate(
        item: BibliographicItemDraft,
        source_provider: str,
        project_id: str | None = None,
        source_external_key: str | None = None,
        source_url: str | None = None,
        source_schema_version: str | None = None,
        raw_payload: dict[str, Any] | None = None,
        rank: float | None = None,
        rationale: str | None = None,
    ) -> dict[str, Any]:
        return facade.stage_candidate(
            _caller(),
            item,
            project_id=project_id,
            source_provider=source_provider,
            source_external_key=source_external_key,
            source_url=source_url,
            source_schema_version=source_schema_version,
            raw_payload=raw_payload,
            rank=rank,
            rationale=rationale,
        )

    return server


def _caller() -> _Caller:
    token = get_access_token()
    if token is None:
        raise AgentToolPermissionError("missing agent capability token")
    claims = token.claims or {}
    run_id = claims.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        raise AgentToolPermissionError("capability token has no run identity")
    project_id = claims.get("project_id")
    if project_id is not None and not isinstance(project_id, str):
        raise AgentToolPermissionError("capability token has an invalid project identity")
    return _Caller(
        run_id=run_id,
        project_id=project_id,
        scopes=frozenset(token.scopes),
    )
