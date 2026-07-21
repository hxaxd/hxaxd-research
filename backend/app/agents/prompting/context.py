from __future__ import annotations

from app.catalog.queries import CatalogQueries
from app.documents import DocumentService, DocumentStatus
from app.integrations.zotero.models import PublicTransferPreview
from app.integrations.zotero.service import ZoteroTransferService
from app.library.models import PublicAttachment
from app.library.service import AttachmentService
from app.preferences import PreferencesService
from app.reading import ReadingService
from app.screening.queries import ScreeningQueries

from ..models import PublicAgentTaskDefinition
from .models import PromptContext
from .policies import AgentTaskPolicyRegistry
from .templates import constraints_for_task


class AgentPromptContextBuilder:
    """Build trusted task context from domain projections, never browser-supplied JSON."""

    def __init__(
        self,
        catalog: CatalogQueries,
        screening: ScreeningQueries,
        attachments: AttachmentService,
        zotero: ZoteroTransferService | None = None,
        policies: AgentTaskPolicyRegistry | None = None,
        *,
        documents: DocumentService | None = None,
        reading: ReadingService | None = None,
        preferences: PreferencesService | None = None,
    ) -> None:
        self.catalog = catalog
        self.screening = screening
        self.attachments = attachments
        self.documents = documents
        self.reading = reading
        self.preferences = preferences
        self.zotero = zotero
        self.policies = policies or AgentTaskPolicyRegistry()

    def scopes_for(
        self,
        task_kind: str,
        project_id: str | None,
        item_id: str | None = None,
        target_type: str | None = None,
        target_id: str | None = None,
    ) -> tuple[str, ...]:
        policy = self.policies.resolve(
            task_kind, project_id, item_id, target_type, target_id
        )
        configured = (
            self.preferences.get().agent.enabled_capabilities
            if self.preferences is not None
            else [
                "catalog_read",
                "candidate_propose",
                "metadata_propose",
                "resource_propose",
                "zotero_conflict_propose",
                "web_search",
            ]
        )
        return self.policies.restrict_scopes(policy, configured)

    def tools_for_scopes(self, scopes: tuple[str, ...]) -> tuple[str, ...]:
        return self.policies.tools_for_scopes(scopes)

    def task_definitions(
        self, *, runtime_ready: bool, runtime_message: str
    ) -> list[PublicAgentTaskDefinition]:
        configured = (
            self.preferences.get().agent.enabled_capabilities
            if self.preferences is not None
            else list(self.policies.default_capabilities())
        )
        return self.policies.definitions(
            configured,
            runtime_ready=runtime_ready,
            runtime_message=runtime_message,
        )

    def resolve(
        self,
        *,
        task_kind: str,
        goal: str,
        project_id: str | None,
        item_id: str | None,
        target_type: str | None = None,
        target_id: str | None = None,
    ) -> PromptContext:
        policy = self.policies.resolve(
            task_kind, project_id, item_id, target_type, target_id
        )
        project = None
        items: list[dict] = []
        attachments: list[dict] = []
        prior_decisions: list[dict] = []
        task_data: dict = {}
        documents: list[dict] = []
        reading_memory: dict = {}
        configured = self.preferences.get() if self.preferences is not None else None
        summary = configured.agent.context_summary if configured is not None else "balanced"
        project_limits = {"compact": 50, "balanced": 150, "detailed": 500}
        block_limits = {"compact": 24, "balanced": 100, "detailed": 300}
        if project_id is not None:
            project = self.screening.get_project(project_id).model_dump(mode="json")
            memberships = self.screening.list_project_works(
                project_id, limit=project_limits[summary]
            )
            items = [membership.model_dump(mode="json") for membership in memberships]
            prior_decisions = [
                {
                    "work_id": membership.work_id,
                    "status": membership.status.value,
                    "relevance": membership.relevance,
                    "decided_at": (
                        membership.decided_at.isoformat()
                        if membership.decided_at is not None
                        else None
                    ),
                }
                for membership in memberships
                if membership.status.value != "discovered"
            ]
        if item_id is not None:
            item = self.catalog.get_item(item_id)
            if project_id is not None and not any(
                membership["work_id"] == item.work_id for membership in items
            ):
                raise ValueError("文献不属于指定项目")
            items = [item.model_dump(mode="json")]
            attachments = [
                PublicAttachment.from_internal(attachment).model_dump(mode="json")
                for attachment in self.attachments.list_for_item(item_id)
            ]
            if self.documents is not None:
                documents = self._document_context(
                    item_id,
                    limit=block_limits[summary],
                    target_language=(
                        configured.reader.target_language if configured is not None else None
                    ),
                )
            if self.reading is not None and project_id is not None:
                reading_memory = {
                    "state": self.reading.state(project_id, item_id).model_dump(mode="json"),
                    "annotations": [
                        annotation.model_dump(mode="json")
                        for annotation in self.reading.annotations(project_id, item_id)
                    ],
                }
        if target_type == "zotero_preview" and target_id is not None:
            if self.zotero is None:
                raise ValueError("Zotero 上下文服务不可用")
            preview = self.zotero.get_preview(target_id)
            task_data["zotero_transfer_preview"] = PublicTransferPreview.from_internal(
                preview
            ).model_dump(mode="json")
        scopes = self.scopes_for(
            task_kind, project_id, item_id, target_type, target_id
        )
        return PromptContext(
            objective=goal,
            scope={
                "task_kind": task_kind,
                "project_id": project_id,
                "item_id": item_id,
                "target_type": target_type,
                "target_id": target_id,
            },
            project=project,
            items=items,
            attachments=attachments,
            documents=documents,
            reading_memory=reading_memory,
            task_data=task_data,
            capabilities={
                "mcp_tools": list(self.tools_for_scopes(scopes)),
                "tool_scopes": list(scopes),
                "screening_decisions": "user_only",
                "context_summary": summary,
            },
            prior_decisions=prior_decisions,
            constraints=constraints_for_task(policy.name),
        )

    def _document_context(
        self, item_id: str, *, limit: int, target_language: str | None
    ) -> list[dict]:
        assert self.documents is not None
        result: list[dict] = []
        for document in self.documents.list_for_item(item_id):
            payload = document.model_dump(mode="json")
            if document.status is DocumentStatus.READY:
                page = self.documents.blocks(
                    document.id,
                    offset=0,
                    limit=limit,
                    target_language=target_language,
                )
                payload["blocks"] = [
                    {
                        "id": block.id,
                        "kind": block.kind.value,
                        "semantic_role": (
                            block.semantic_role.value if block.semantic_role else None
                        ),
                        "source_text": block.source_text,
                        "translated_text": (
                            block.translation.translated_text
                            if block.translation is not None
                            else None
                        ),
                        "page_start": block.page_start,
                        "section_path": block.section_path,
                        "source_sha256": block.source_sha256,
                    }
                    for block in page.items
                ]
                payload["blocks_truncated"] = page.total > len(page.items)
            result.append(payload)
        return result
