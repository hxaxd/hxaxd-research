from __future__ import annotations

from app.platform.public_projection import sanitize_public_payload, sanitize_public_text

from .models import (
    AgentEvent,
    AgentRun,
    Approval,
    PublicAgentEvent,
    PublicAgentRun,
    PublicApproval,
)


def project_public_run(run: AgentRun) -> PublicAgentRun:
    return PublicAgentRun(
        id=run.id,
        task_kind=run.task_kind,
        status=run.status,
        goal=run.goal,
        project_id=run.project_id,
        item_id=run.item_id,
        target_type=run.target_type,
        target_id=run.target_id,
        tool_scopes=run.tool_scopes,
        runtime=run.runtime,
        runtime_version=run.runtime_version,
        model=run.model,
        reasoning_effort=run.reasoning_effort,
        final_message=sanitize_public_text(run.final_message),
        error_code=run.error_code,
        error_message=sanitize_public_text(run.error_message),
        created_at=run.created_at,
        updated_at=run.updated_at,
        started_at=run.started_at,
        finished_at=run.finished_at,
        cancel_requested_at=run.cancel_requested_at,
    )


def project_public_agent_event(event: AgentEvent) -> PublicAgentEvent:
    payload = sanitize_public_payload(event.payload)
    if event.event_type.startswith(("item.", "web_search.")):
        payload.pop("id", None)
    return PublicAgentEvent(
        id=event.id,
        run_id=event.run_id,
        event_type=event.event_type,
        payload=payload,
        created_at=event.created_at,
    )


def project_public_approval(approval: Approval) -> PublicApproval:
    request = {
        key: value
        for key, value in approval.request.items()
        if key
        not in {
            "approvalId",
            "approval_id",
            "grantRoot",
            "grant_root",
            "itemId",
            "item_id",
            "method",
            "proposedExecpolicyAmendment",
            "proposed_execpolicy_amendment",
        }
    }
    return PublicApproval(
        id=approval.id,
        run_id=approval.run_id,
        kind=approval.kind,
        status=approval.status,
        approvable=approval.approvable,
        request=sanitize_public_payload(request),
        decision=approval.decision,
        created_at=approval.created_at,
        decided_at=approval.decided_at,
    )
