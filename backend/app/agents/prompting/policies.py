from __future__ import annotations

from dataclasses import dataclass

from app.agents.runtime import WEB_SEARCH_SCOPE

READ_SCOPE = "literature:read"
STAGE_SCOPE = "candidates:stage"
METADATA_PROPOSE_SCOPE = "changes:metadata:propose"
RESOURCE_PROPOSE_SCOPE = "changes:resource:propose"
PROJECT_INSIGHTS_PROPOSE_SCOPE = "changes:project-insights:propose"
ZOTERO_CONFLICT_PROPOSE_SCOPE = "changes:zotero-conflict:propose"

_CAPABILITY_SCOPES = {
    "catalog_read": READ_SCOPE,
    "candidate_propose": STAGE_SCOPE,
    "metadata_propose": METADATA_PROPOSE_SCOPE,
    "resource_propose": RESOURCE_PROPOSE_SCOPE,
    "zotero_conflict_propose": ZOTERO_CONFLICT_PROPOSE_SCOPE,
    "web_search": WEB_SEARCH_SCOPE,
}

_REQUIRED_CAPABILITIES = {
    "literature_search": frozenset({"catalog_read", "candidate_propose", "web_search"}),
    "metadata_enrichment": frozenset({"catalog_read", "metadata_propose"}),
    "resource_acquisition": frozenset({"catalog_read", "resource_propose"}),
    "conflict_resolution": frozenset({"catalog_read", "zotero_conflict_propose"}),
}


@dataclass(frozen=True)
class AgentTaskPolicy:
    name: str
    aliases: frozenset[str]
    scopes: tuple[str, ...]
    requires_project: bool = False
    requires_item: bool = False
    requires_target_type: str | None = None


_READ_ONLY = AgentTaskPolicy(
    name="read_only",
    aliases=frozenset(),
    scopes=(READ_SCOPE,),
)

_POLICIES = (
    AgentTaskPolicy(
        name="literature_search",
        aliases=frozenset({"literature_search", "discovery", "candidate_search"}),
        scopes=(READ_SCOPE, STAGE_SCOPE, WEB_SEARCH_SCOPE),
        requires_project=True,
    ),
    AgentTaskPolicy(
        name="metadata_enrichment",
        aliases=frozenset({"metadata_enrichment"}),
        scopes=(READ_SCOPE, METADATA_PROPOSE_SCOPE, PROJECT_INSIGHTS_PROPOSE_SCOPE),
        requires_item=True,
    ),
    AgentTaskPolicy(
        name="resource_acquisition",
        aliases=frozenset({"resource_acquisition"}),
        scopes=(READ_SCOPE, RESOURCE_PROPOSE_SCOPE),
        requires_item=True,
    ),
    AgentTaskPolicy(
        name="conflict_resolution",
        aliases=frozenset({"conflict_resolution"}),
        scopes=(READ_SCOPE, ZOTERO_CONFLICT_PROPOSE_SCOPE),
        requires_target_type="zotero_preview",
    ),
)


class AgentTaskPolicyRegistry:
    """Code-owned task permissions; prompt prose never grants capabilities."""

    def resolve(
        self,
        task_kind: str,
        project_id: str | None,
        item_id: str | None = None,
        target_type: str | None = None,
        target_id: str | None = None,
    ) -> AgentTaskPolicy:
        normalized = normalize_task_kind(task_kind)
        policy = next(
            (candidate for candidate in _POLICIES if normalized in candidate.aliases),
            _READ_ONLY,
        )
        if policy.requires_project and project_id is None:
            raise ValueError("文献检索任务必须绑定项目")
        if policy.requires_item and item_id is None:
            raise ValueError("该智能体任务必须绑定文献条目")
        if policy.requires_target_type is not None and (
            target_type != policy.requires_target_type or target_id is None
        ):
            raise ValueError("该智能体任务必须绑定对应的领域目标")
        return policy

    @staticmethod
    def tools_for_scopes(scopes: tuple[str, ...]) -> tuple[str, ...]:
        tools: list[str] = []
        if READ_SCOPE in scopes:
            tools.extend(
                (
                    "workspace_summary",
                    "get_project",
                    "list_project_works",
                    "get_bibliographic_item",
                    "list_candidates",
                )
            )
        if STAGE_SCOPE in scopes:
            tools.append("stage_candidate")
        if METADATA_PROPOSE_SCOPE in scopes:
            tools.append("propose_metadata_patch")
        if RESOURCE_PROPOSE_SCOPE in scopes:
            tools.append("propose_resource_acquisition")
        if PROJECT_INSIGHTS_PROPOSE_SCOPE in scopes:
            tools.append("propose_project_insights")
        if ZOTERO_CONFLICT_PROPOSE_SCOPE in scopes:
            tools.extend(
                ("get_zotero_transfer_preview", "propose_zotero_conflict_resolution")
            )
        return tuple(tools)

    @staticmethod
    def restrict_scopes(
        policy: AgentTaskPolicy, enabled_capabilities: list[str]
    ) -> tuple[str, ...]:
        enabled = set(enabled_capabilities)
        missing = _REQUIRED_CAPABILITIES.get(policy.name, frozenset()) - enabled
        if missing:
            raise ValueError(
                "当前智能体设置关闭了任务必需能力：" + ", ".join(sorted(missing))
            )
        enabled_scopes = {
            scope for capability, scope in _CAPABILITY_SCOPES.items() if capability in enabled
        }
        if "metadata_propose" in enabled:
            enabled_scopes.add(PROJECT_INSIGHTS_PROPOSE_SCOPE)
        return tuple(scope for scope in policy.scopes if scope in enabled_scopes)


def normalize_task_kind(task_kind: str) -> str:
    return task_kind.strip().casefold().replace("-", "_").replace(".", "_")
