from __future__ import annotations

from app.catalog.queries import CatalogQueries
from app.library.models import PublicAttachment
from app.library.service import AttachmentService
from app.screening.queries import ScreeningQueries

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
        policies: AgentTaskPolicyRegistry | None = None,
    ) -> None:
        self.catalog = catalog
        self.screening = screening
        self.attachments = attachments
        self.policies = policies or AgentTaskPolicyRegistry()

    def scopes_for(self, task_kind: str, project_id: str | None) -> tuple[str, ...]:
        return self.policies.resolve(task_kind, project_id).scopes

    def tools_for_scopes(self, scopes: tuple[str, ...]) -> tuple[str, ...]:
        return self.policies.tools_for_scopes(scopes)

    def resolve(
        self,
        *,
        task_kind: str,
        goal: str,
        project_id: str | None,
        item_id: str | None,
    ) -> PromptContext:
        policy = self.policies.resolve(task_kind, project_id)
        project = None
        items: list[dict] = []
        attachments: list[dict] = []
        prior_decisions: list[dict] = []
        if project_id is not None:
            project = self.screening.get_project(project_id).model_dump(mode="json")
            memberships = self.screening.list_project_works(project_id, limit=500)
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
        scopes = policy.scopes
        return PromptContext(
            objective=goal,
            scope={
                "task_kind": task_kind,
                "project_id": project_id,
                "item_id": item_id,
            },
            project=project,
            items=items,
            attachments=attachments,
            capabilities={
                "mcp_tools": list(self.tools_for_scopes(scopes)),
                "tool_scopes": list(scopes),
                "screening_decisions": "user_only",
            },
            prior_decisions=prior_decisions,
            constraints=constraints_for_task(policy.name),
        )
