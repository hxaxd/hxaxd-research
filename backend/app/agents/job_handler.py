from __future__ import annotations

from app.jobs import JobExecutionContext, JobExecutionResult, JobFailure

from .models import AgentRunStatus
from .supervisor import AgentSupervisor

AGENT_RUN_JOB_KIND = "agent.run"


class AgentRunJobHandler:
    """Bridges durable jobs to the synchronous AgentSupervisor execution boundary."""

    def __init__(self, supervisor: AgentSupervisor) -> None:
        self.supervisor = supervisor

    def __call__(self, context: JobExecutionContext) -> JobExecutionResult:
        run_id = context.claimed.job.input.get("run_id")
        if not isinstance(run_id, str) or not run_id:
            raise JobFailure("invalid_agent_job", "agent.run requires a run_id")
        persisted = self.supervisor.repository.get(run_id)
        if persisted.status is not AgentRunStatus.CREATED:
            raise JobFailure(
                persisted.error_code or "agent_run_not_executable",
                persisted.error_message
                or f"agent run cannot execute from {persisted.status.value}",
            )
        context.emit("agent.run.started", {"run_id": run_id}, "info")
        run = self.supervisor.execute(
            run_id,
            reasoning_effort=persisted.reasoning_effort,
            cancellation=context.cancellation,
        )
        if run.status is AgentRunStatus.FAILED:
            raise JobFailure(
                run.error_code or "agent_run_failed",
                run.error_message or "agent run failed",
            )
        context.emit("agent.run.finished", {"run_id": run_id, "status": run.status.value}, "info")
        return JobExecutionResult(
            result={
                "agent_run_id": run.id,
                "status": run.status.value,
                "final_message": run.final_message,
            }
        )
