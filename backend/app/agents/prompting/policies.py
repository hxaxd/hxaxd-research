from __future__ import annotations

from dataclasses import dataclass

from app.agents.runtime import WEB_SEARCH_SCOPE

READ_SCOPE = "literature:read"
STAGE_SCOPE = "candidates:stage"


@dataclass(frozen=True)
class AgentTaskPolicy:
    name: str
    aliases: frozenset[str]
    scopes: tuple[str, ...]
    requires_project: bool = False


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
        scopes=(READ_SCOPE,),
    ),
    AgentTaskPolicy(
        name="resource_acquisition",
        aliases=frozenset({"resource_acquisition"}),
        scopes=(READ_SCOPE,),
    ),
    AgentTaskPolicy(
        name="conflict_resolution",
        aliases=frozenset({"conflict_resolution"}),
        scopes=(READ_SCOPE,),
    ),
)


class AgentTaskPolicyRegistry:
    """Code-owned task permissions; prompt prose never grants capabilities."""

    def resolve(self, task_kind: str, project_id: str | None) -> AgentTaskPolicy:
        normalized = normalize_task_kind(task_kind)
        policy = next(
            (candidate for candidate in _POLICIES if normalized in candidate.aliases),
            _READ_ONLY,
        )
        if policy.requires_project and project_id is None:
            raise ValueError("文献检索任务必须绑定项目")
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
        return tuple(tools)


def normalize_task_kind(task_kind: str) -> str:
    return task_kind.strip().casefold().replace("-", "_").replace(".", "_")
