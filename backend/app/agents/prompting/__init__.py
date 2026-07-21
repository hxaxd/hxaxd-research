"""Single modification boundary for agent task policy, context, and prompt rendering."""

from .assembler import PromptAssembler
from .context import AgentPromptContextBuilder
from .models import PromptContext, PromptSnapshot
from .policies import (
    READ_SCOPE,
    STAGE_SCOPE,
    AgentTaskPolicy,
    AgentTaskPolicyRegistry,
    normalize_task_kind,
)
from .templates import (
    BASE_CONTEXT_CONSTRAINTS,
    MCP_SERVER_INSTRUCTIONS,
    PROMPT_VERSION,
    TASK_CONTEXT_CONSTRAINTS,
    constraints_for_task,
    render_user_prompt,
)

__all__ = [
    "AgentPromptContextBuilder",
    "AgentTaskPolicy",
    "AgentTaskPolicyRegistry",
    "BASE_CONTEXT_CONSTRAINTS",
    "MCP_SERVER_INSTRUCTIONS",
    "PROMPT_VERSION",
    "PromptAssembler",
    "PromptContext",
    "PromptSnapshot",
    "READ_SCOPE",
    "STAGE_SCOPE",
    "TASK_CONTEXT_CONSTRAINTS",
    "constraints_for_task",
    "normalize_task_kind",
    "render_user_prompt",
]
