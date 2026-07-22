from __future__ import annotations

import time
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from threading import Event, Lock
from uuid import uuid4

from app.platform.processes import CancellationToken

from .models import AgentRun, AgentRunCreate, AgentRunStatus, Approval, ApprovalDecision
from .prompting import PromptAssembler, PromptContext
from .repository import (
    AgentConflictError,
    AgentIdentityConflictError,
    SqliteAgentRunRepository,
)
from .runtime import (
    AgentRuntime,
    AgentRuntimeDefinition,
    AgentRuntimeRegistry,
    RuntimeApprovalRequest,
    RuntimeEvent,
    RuntimeMcpCredentials,
    RuntimeOutcome,
    RuntimeOutcomeStatus,
    RuntimeRequest,
)


class AgentSupervisor:
    """Persists lifecycle state while a replaceable runtime performs one agent turn."""

    def __init__(
        self,
        repository: SqliteAgentRunRepository,
        runtime: AgentRuntime | AgentRuntimeRegistry,
        prompts: PromptAssembler,
        workspace_root: Path,
        *,
        approval_timeout_seconds: float = 900,
        mcp_credentials: Callable[[AgentRun], RuntimeMcpCredentials | None] | None = None,
        mcp_revoke: Callable[[str], None] | None = None,
    ) -> None:
        self.repository = repository
        self.runtime_registry = (
            runtime
            if isinstance(runtime, AgentRuntimeRegistry)
            else AgentRuntimeRegistry.single(runtime)
        )
        self.prompts = prompts
        self.workspace_root = workspace_root.resolve()
        self.approval_timeout_seconds = approval_timeout_seconds
        self.mcp_credentials = mcp_credentials
        self.mcp_revoke = mcp_revoke
        self._tokens: dict[str, CancellationToken] = {}
        self._approval_waiters: dict[str, Event] = {}
        self._lock = Lock()

    def create(
        self,
        task_kind: str,
        context: PromptContext,
        *,
        project_id: str | None = None,
        item_id: str | None = None,
        target_type: str | None = None,
        target_id: str | None = None,
        tool_scopes: tuple[str, ...] = (),
        runtime: str | None = None,
        model: str | None = None,
        reasoning_effort: str | None = None,
    ) -> AgentRun:
        snapshot = self.prompts.assemble(context)
        registration = self.runtime_registry.registration(runtime)
        selected_model = self.runtime_registry.resolve_model(
            registration.definition.id,
            model,
        )
        run_id = uuid4().hex
        cwd = self.workspace_root / run_id
        cwd.mkdir(parents=True, exist_ok=False)
        try:
            return self.repository.create(
                AgentRunCreate(
                    id=run_id,
                    task_kind=task_kind,
                    goal=context.objective,
                    prompt=snapshot.prompt,
                    prompt_version=snapshot.version,
                    context_hash=snapshot.context_hash,
                    cwd=str(cwd),
                    project_id=project_id,
                    item_id=item_id,
                    target_type=target_type,
                    target_id=target_id,
                    tool_scopes=tool_scopes,
                    runtime=registration.definition.id,
                    runtime_version=registration.definition.version,
                    model=selected_model,
                    reasoning_effort=reasoning_effort,
                )
            )
        except Exception:
            with suppress(OSError):
                cwd.rmdir()
            raise

    def execute(
        self,
        run_id: str,
        *,
        reasoning_effort: str | None = None,
        cancellation: CancellationToken | None = None,
    ) -> AgentRun:
        run = self.repository.get(run_id)
        if run.status is not AgentRunStatus.CREATED:
            raise AgentConflictError(f"agent run cannot execute from {run.status.value}")
        token = cancellation or CancellationToken()
        with self._lock:
            self._tokens[run_id] = token
        try:
            try:
                run = self.repository.claim_execution(run_id)
            except AgentConflictError:
                current = self.repository.get(run_id)
                if current.status is AgentRunStatus.CANCELED:
                    token.cancel()
                    return current
                if current.status is AgentRunStatus.CANCELLATION_REQUESTED:
                    token.cancel()
                    return self.repository.transition(run_id, AgentRunStatus.CANCELED)
                raise
            if self.repository.get(run_id).status is AgentRunStatus.CANCELLATION_REQUESTED:
                token.cancel()

            target_status = AgentRunStatus.FAILED
            transition_values: dict[str, str | None] = {}
            revoke_error: Exception | None = None
            try:
                if token.is_cancelled:
                    outcome = RuntimeOutcome(
                        RuntimeOutcomeStatus.CANCELED,
                        run.provider_thread_id,
                        run.provider_turn_id,
                    )
                else:
                    runtime = self.runtime_registry.runtime(run.runtime)
                    mcp = self.mcp_credentials(run) if self.mcp_credentials is not None else None
                    outcome = runtime.run(
                        RuntimeRequest(
                            run_id=run_id,
                            prompt=run.prompt,
                            cwd=Path(run.cwd),
                            thread_id=run.provider_thread_id,
                            model=run.model,
                            reasoning_effort=reasoning_effort or run.reasoning_effort,
                            tool_scopes=run.tool_scopes,
                            mcp=mcp,
                        ),
                        lambda event: self._record_event(run_id, event),
                        lambda request: self._request_approval(run_id, request, token),
                        token,
                    )
                current = self.repository.get(run_id)
                if (
                    outcome.status is RuntimeOutcomeStatus.CANCELED
                    or current.status is AgentRunStatus.CANCELLATION_REQUESTED
                ):
                    target_status = AgentRunStatus.CANCELED
                elif outcome.status is RuntimeOutcomeStatus.COMPLETED:
                    target_status = AgentRunStatus.COMPLETED
                else:
                    target_status = AgentRunStatus.FAILED
                transition_values = {
                    "provider_thread_id": outcome.thread_id,
                    "provider_turn_id": outcome.turn_id,
                    "final_message": outcome.final_message,
                    "error_code": outcome.error_code,
                    "error_message": outcome.error_message,
                }
            except AgentIdentityConflictError:
                self._record_provider_identity_mismatch(run_id)
                target_status = AgentRunStatus.FAILED
                transition_values = self._provider_identity_failure()
            except Exception as error:
                current = self.repository.get(run_id)
                if current.status is AgentRunStatus.CANCELLATION_REQUESTED:
                    target_status = AgentRunStatus.CANCELED
                else:
                    target_status = AgentRunStatus.FAILED
                    transition_values = {
                        "error_code": "agent_runtime_error",
                        "error_message": str(error)[-4000:],
                    }
            finally:
                if self.mcp_revoke is not None:
                    try:
                        self.mcp_revoke(run_id)
                    except Exception as error:
                        revoke_error = error

            if revoke_error is not None:
                with suppress(Exception):
                    self.repository.append_event(
                        run_id,
                        "security.mcp_revoke_failed",
                        {"error_type": type(revoke_error).__name__},
                        visibility="internal",
                    )
                target_status = AgentRunStatus.FAILED
                transition_values = {
                    "error_code": "mcp_revoke_failed",
                    "error_message": "failed to revoke the run's MCP capability",
                }
            return self._finish_execution(run_id, target_status, transition_values)
        finally:
            with self._lock:
                self._tokens.pop(run_id, None)

    def _finish_execution(
        self,
        run_id: str,
        target_status: AgentRunStatus,
        transition_values: dict[str, str | None],
    ) -> AgentRun:
        try:
            return self.repository.transition(run_id, target_status, **transition_values)
        except AgentIdentityConflictError:
            self._record_provider_identity_mismatch(run_id)
            return self.repository.transition(
                run_id,
                AgentRunStatus.FAILED,
                **self._provider_identity_failure(),
            )
        except AgentConflictError:
            current = self.repository.get(run_id)
            if current.status is AgentRunStatus.CANCELLATION_REQUESTED:
                try:
                    return self.repository.transition(
                        run_id,
                        AgentRunStatus.CANCELED,
                        **transition_values,
                    )
                except AgentIdentityConflictError:
                    self._record_provider_identity_mismatch(run_id)
                    return self.repository.transition(
                        run_id,
                        AgentRunStatus.FAILED,
                        **self._provider_identity_failure(),
                    )
            if current.status.terminal:
                return current
            raise

    def _record_provider_identity_mismatch(self, run_id: str) -> None:
        self.repository.append_event(
            run_id,
            "security.provider_thread_mismatch",
            {},
            visibility="internal",
        )

    @staticmethod
    def _provider_identity_failure() -> dict[str, str | None]:
        return {
            "error_code": "provider_thread_mismatch",
            "error_message": "runtime changed provider thread identity during one run",
        }

    def cancel(self, run_id: str) -> AgentRun:
        run = self.repository.request_cancel(run_id)
        with self._lock:
            token = self._tokens.get(run_id)
        if token is not None:
            token.cancel()
        self.runtime_registry.runtime(run.runtime).interrupt(run_id)
        return run

    def runtime_definitions(self) -> tuple[AgentRuntimeDefinition, ...]:
        return self.runtime_registry.definitions()

    def resume(self, run_id: str, *, reasoning_effort: str | None = None) -> AgentRun:
        self.prepare_resume(run_id)
        return self.execute(run_id, reasoning_effort=reasoning_effort)

    def prepare_resume(self, run_id: str) -> AgentRun:
        return self.repository.prepare_resume(run_id)

    def resolve_approval(self, approval_id: str, decision: ApprovalDecision) -> Approval:
        approval = self.repository.resolve_approval(approval_id, decision)
        with self._lock:
            waiter = self._approval_waiters.get(approval_id)
        if waiter is not None:
            waiter.set()
        return approval

    def _record_event(self, run_id: str, event: RuntimeEvent) -> None:
        thread_id = event.payload.get("thread_id") if event.event_type == "thread.started" else None
        turn_id = event.payload.get("turn_id") if event.event_type == "turn.started" else None
        identity_event = event.event_type in {"thread.started", "turn.started"}
        self.repository.record_runtime_event(
            run_id,
            event.event_type,
            event.payload,
            visibility="internal" if identity_event else event.visibility,
            provider_thread_id=thread_id if isinstance(thread_id, str) else None,
            provider_turn_id=turn_id if isinstance(turn_id, str) else None,
        )

    def _request_approval(
        self,
        run_id: str,
        request: RuntimeApprovalRequest,
        cancellation: CancellationToken,
    ) -> ApprovalDecision:
        approval = self.repository.create_approval(
            run_id,
            request.provider_request_id,
            request.kind,
            request.summary,
            approvable=request.approvable,
        )
        if not request.approvable:
            self.repository.resolve_approval(approval.id, ApprovalDecision.DENY)
            return ApprovalDecision.DENY
        self.repository.transition(run_id, AgentRunStatus.WAITING_APPROVAL)
        waiter = Event()
        with self._lock:
            self._approval_waiters[approval.id] = waiter
        deadline = time.monotonic() + self.approval_timeout_seconds
        try:
            while not cancellation.is_cancelled:
                current_approval = self.repository.get_approval(approval.id)
                if current_approval.status.value != "pending":
                    return current_approval.decision or ApprovalDecision.DENY
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    with suppress(AgentConflictError):
                        self.repository.resolve_approval(
                            approval.id, ApprovalDecision.DENY, expired=True
                        )
                    return ApprovalDecision.DENY
                if waiter.wait(min(0.25, remaining)):
                    resolved = self.repository.get_approval(approval.id)
                    return resolved.decision or ApprovalDecision.DENY
            with suppress(AgentConflictError):
                self.repository.resolve_approval(approval.id, ApprovalDecision.CANCEL)
            return ApprovalDecision.CANCEL
        finally:
            with self._lock:
                self._approval_waiters.pop(approval.id, None)
            current = self.repository.get(run_id)
            if current.status is AgentRunStatus.WAITING_APPROVAL:
                self.repository.transition(run_id, AgentRunStatus.RUNNING)
