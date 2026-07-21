from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from app.agents.prompting import (
    MCP_SERVER_INSTRUCTIONS,
    METADATA_PROPOSE_SCOPE,
    PROJECT_INSIGHTS_PROPOSE_SCOPE,
    READ_SCOPE,
    RESOURCE_PROPOSE_SCOPE,
    STAGE_SCOPE,
    ZOTERO_CONFLICT_PROPOSE_SCOPE,
)
from app.catalog.models import BibliographicItemDraft, BibliographicItemPatch
from app.catalog.queries import CatalogQueries
from app.changes import ChangeSetCreate, ChangeSetService
from app.changes.models import (
    EvidenceReference,
    MetadataChangeItemCreate,
    MetadataPatchPayload,
    ProjectInsightsChangeItemCreate,
    ProjectInsightsPayload,
    ResourceAcquisitionPayload,
    ResourceChangeItemCreate,
    ZoteroConflictChangeItemCreate,
    ZoteroConflictPayload,
)
from app.integrations.zotero.models import ConflictResolution, PublicTransferPreview
from app.integrations.zotero.service import ZoteroTransferService
from app.operations.models import AttachmentDownloadRequest
from app.screening.commands import ScreeningCommands
from app.screening.domain import CandidateState
from app.screening.models import CandidateCreate, ProjectInsightsPatch
from app.screening.queries import ScreeningQueries
from app.workspace.service import WorkspaceProjectionService

from .capabilities import AgentCapabilityRegistry


class AgentToolPermissionError(PermissionError):
    pass


@dataclass(frozen=True)
class _Caller:
    run_id: str
    project_id: str | None
    item_id: str | None
    target_type: str | None
    target_id: str | None
    scopes: frozenset[str]


class AgentToolFacade:
    """Auditable domain-tool boundary; it never exposes a database handle."""

    def __init__(
        self,
        workspace: WorkspaceProjectionService,
        catalog: CatalogQueries,
        screening_queries: ScreeningQueries,
        screening_commands: ScreeningCommands,
        changes: ChangeSetService,
        zotero: ZoteroTransferService,
    ) -> None:
        self.workspace = workspace
        self.catalog = catalog
        self.screening_queries = screening_queries
        self.screening_commands = screening_commands
        self.changes = changes
        self.zotero = zotero

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
        self._item_target(caller, item_id)
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

    def propose_metadata_patch(
        self,
        caller: _Caller,
        *,
        base_revision: int,
        patch: BibliographicItemPatch,
        evidence: list[EvidenceReference],
        summary: str,
        rationale: str | None = None,
        source_version: str | None = None,
        item_id: str | None = None,
    ) -> dict[str, Any]:
        self._require(caller, METADATA_PROPOSE_SCOPE)
        target = self._item_target(caller, item_id)
        result = self.changes.propose(
            ChangeSetCreate(
                kind="metadata_patch",
                summary=summary,
                project_id=caller.project_id,
                item_id=target,
                source_version=source_version,
                items=[
                    MetadataChangeItemCreate(
                        operation="metadata.patch",
                        target_id=target,
                        base_revision=base_revision,
                        payload=MetadataPatchPayload(patch=patch),
                        evidence=evidence,
                        rationale=rationale,
                    )
                ],
            ),
            agent_run_id=caller.run_id,
            actor_type="agent",
            actor_id=caller.run_id,
        )
        return result.model_dump(mode="json")

    def propose_resource_acquisition(
        self,
        caller: _Caller,
        *,
        base_revision: int,
        request: AttachmentDownloadRequest,
        evidence: list[EvidenceReference],
        summary: str,
        rationale: str | None = None,
        source_version: str | None = None,
        item_id: str | None = None,
    ) -> dict[str, Any]:
        self._require(caller, RESOURCE_PROPOSE_SCOPE)
        target = self._item_target(caller, item_id)
        result = self.changes.propose(
            ChangeSetCreate(
                kind="resource_acquisition",
                summary=summary,
                project_id=caller.project_id,
                item_id=target,
                source_version=source_version,
                items=[
                    ResourceChangeItemCreate(
                        operation="resource.acquire",
                        target_id=target,
                        base_revision=base_revision,
                        payload=ResourceAcquisitionPayload(request=request),
                        evidence=evidence,
                        rationale=rationale,
                    )
                ],
            ),
            agent_run_id=caller.run_id,
            actor_type="agent",
            actor_id=caller.run_id,
        )
        return result.model_dump(mode="json")

    def propose_project_insights(
        self,
        caller: _Caller,
        *,
        project_work_id: str,
        work_id: str,
        base_updated_at: str,
        patch: ProjectInsightsPatch,
        summary: str,
        evidence: list[EvidenceReference],
        rationale: str | None = None,
    ) -> dict[str, Any]:
        self._require(caller, PROJECT_INSIGHTS_PROPOSE_SCOPE)
        project_id = self._project(caller, None)
        if caller.item_id is not None:
            bound_item = self.catalog.get_project_item(project_id, caller.item_id)
            if bound_item.work_id != work_id:
                raise AgentToolPermissionError("project work is outside the bound item")
        payload = ProjectInsightsPayload(
            project_id=project_id,
            work_id=work_id,
            base_updated_at=base_updated_at,
            patch=patch,
        )
        normalized_revision = payload.base_updated_at.isoformat().replace("+00:00", "Z")
        result = self.changes.propose(
            ChangeSetCreate(
                kind="project_insights",
                summary=summary,
                project_id=project_id,
                item_id=caller.item_id,
                items=[
                    ProjectInsightsChangeItemCreate(
                        operation="project.insight.patch",
                        target_id=project_work_id,
                        base_revision=normalized_revision,
                        payload=payload,
                        evidence=evidence,
                        rationale=rationale,
                    )
                ],
            ),
            agent_run_id=caller.run_id,
            actor_type="agent",
            actor_id=caller.run_id,
        )
        return result.model_dump(mode="json")

    def propose_zotero_conflict_resolution(
        self,
        caller: _Caller,
        *,
        preview_id: str,
        expected_preview_hash: str,
        resolution: ConflictResolution,
        summary: str,
        evidence: list[EvidenceReference],
        rationale: str | None = None,
    ) -> dict[str, Any]:
        self._require(caller, ZOTERO_CONFLICT_PROPOSE_SCOPE)
        resolved_preview = self._target(caller, "zotero_preview", preview_id)
        result = self.changes.propose(
            ChangeSetCreate(
                kind="zotero_conflict_resolution",
                summary=summary,
                project_id=caller.project_id,
                item_id=caller.item_id,
                items=[
                    ZoteroConflictChangeItemCreate(
                        operation="zotero.conflict.resolve",
                        target_id=resolution.conflict_id,
                        base_revision=expected_preview_hash,
                        payload=ZoteroConflictPayload(
                            preview_id=resolved_preview,
                            expected_preview_hash=expected_preview_hash,
                            resolution=resolution,
                        ),
                        evidence=evidence,
                        rationale=rationale,
                    )
                ],
            ),
            agent_run_id=caller.run_id,
            actor_type="agent",
            actor_id=caller.run_id,
        )
        return result.model_dump(mode="json")

    def zotero_transfer_preview(
        self, caller: _Caller, preview_id: str | None = None
    ) -> dict[str, Any]:
        self._require(caller, ZOTERO_CONFLICT_PROPOSE_SCOPE)
        resolved = self._target(caller, "zotero_preview", preview_id)
        return PublicTransferPreview.from_internal(
            self.zotero.get_preview(resolved)
        ).model_dump(mode="json")

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

    @staticmethod
    def _item_target(caller: _Caller, requested: str | None) -> str:
        if caller.item_id is not None:
            if requested is not None and requested != caller.item_id:
                raise AgentToolPermissionError("agent run is bound to a different item")
            return caller.item_id
        if requested is None:
            raise AgentToolPermissionError("item_id is required for an unbound run")
        return requested

    @staticmethod
    def _target(caller: _Caller, target_type: str, requested: str | None) -> str:
        if caller.target_type is not None:
            if caller.target_type != target_type or (
                requested is not None and requested != caller.target_id
            ):
                raise AgentToolPermissionError("agent run is bound to a different target")
            if caller.target_id is None:
                raise AgentToolPermissionError("agent target identity is missing")
            return caller.target_id
        if requested is None:
            raise AgentToolPermissionError("target id is required for an unbound run")
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
        instructions=MCP_SERVER_INSTRUCTIONS,
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

    @server.tool(
        name="get_zotero_transfer_preview",
        description=(
            "Return the immutable, public projection of the Zotero transfer preview bound "
            "to this conflict-resolution run."
        ),
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    def get_zotero_transfer_preview(
        preview_id: str | None = None,
    ) -> dict[str, Any]:
        return facade.zotero_transfer_preview(_caller(), preview_id)

    @server.tool(
        name="propose_metadata_patch",
        description=(
            "Submit an evidence-backed metadata patch for user review. The item is not "
            "modified until a user approves and applies the resulting change set."
        ),
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    def propose_metadata_patch(
        base_revision: int,
        patch: BibliographicItemPatch,
        summary: str,
        evidence: list[EvidenceReference] | None = None,
        rationale: str | None = None,
        source_version: str | None = None,
        item_id: str | None = None,
    ) -> dict[str, Any]:
        return facade.propose_metadata_patch(
            _caller(),
            base_revision=base_revision,
            patch=patch,
            evidence=evidence or [],
            summary=summary,
            rationale=rationale,
            source_version=source_version,
            item_id=item_id,
        )

    @server.tool(
        name="propose_resource_acquisition",
        description=(
            "Submit a credential-free HTTPS attachment source for user review. This only "
            "creates a proposal and never downloads the resource directly."
        ),
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    def propose_resource_acquisition(
        base_revision: int,
        request: AttachmentDownloadRequest,
        summary: str,
        evidence: list[EvidenceReference] | None = None,
        rationale: str | None = None,
        source_version: str | None = None,
        item_id: str | None = None,
    ) -> dict[str, Any]:
        return facade.propose_resource_acquisition(
            _caller(),
            base_revision=base_revision,
            request=request,
            evidence=evidence or [],
            summary=summary,
            rationale=rationale,
            source_version=source_version,
            item_id=item_id,
        )

    @server.tool(
        name="propose_project_insights",
        description=(
            "Submit project-specific roles, summary, relevance, contributions, or reading "
            "focus for review. Screening status cannot be changed by this tool."
        ),
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    def propose_project_insights(
        project_work_id: str,
        work_id: str,
        base_updated_at: str,
        patch: ProjectInsightsPatch,
        summary: str,
        evidence: list[EvidenceReference] | None = None,
        rationale: str | None = None,
    ) -> dict[str, Any]:
        return facade.propose_project_insights(
            _caller(),
            project_work_id=project_work_id,
            work_id=work_id,
            base_updated_at=base_updated_at,
            patch=patch,
            summary=summary,
            evidence=evidence or [],
            rationale=rationale,
        )

    @server.tool(
        name="propose_zotero_conflict_resolution",
        description=(
            "Submit a resolution for one conflict in an immutable Zotero transfer preview. "
            "The deterministic transfer remains a separate explicit user action."
        ),
        annotations=ToolAnnotations(
            readOnlyHint=False,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
    )
    def propose_zotero_conflict_resolution(
        preview_id: str,
        expected_preview_hash: str,
        resolution: ConflictResolution,
        summary: str,
        evidence: list[EvidenceReference] | None = None,
        rationale: str | None = None,
    ) -> dict[str, Any]:
        return facade.propose_zotero_conflict_resolution(
            _caller(),
            preview_id=preview_id,
            expected_preview_hash=expected_preview_hash,
            resolution=resolution,
            summary=summary,
            evidence=evidence or [],
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
    item_id = claims.get("item_id")
    if item_id is not None and not isinstance(item_id, str):
        raise AgentToolPermissionError("capability token has an invalid item identity")
    target_type = claims.get("target_type")
    target_id = claims.get("target_id")
    if target_type is not None and not isinstance(target_type, str):
        raise AgentToolPermissionError("capability token has an invalid target type")
    if target_id is not None and not isinstance(target_id, str):
        raise AgentToolPermissionError("capability token has an invalid target identity")
    if (target_type is None) != (target_id is None):
        raise AgentToolPermissionError("capability token has an incomplete target")
    return _Caller(
        run_id=run_id,
        project_id=project_id,
        item_id=item_id,
        target_type=target_type,
        target_id=target_id,
        scopes=frozenset(token.scopes),
    )
