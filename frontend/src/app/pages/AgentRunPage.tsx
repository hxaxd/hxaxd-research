import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { AgentRunTimeline } from "../../features/tasks/AgentRunTimeline";
import { api } from "../../shared/api/client";
import type { AgentEvent, Approval } from "../../shared/api/contracts";
import { useApiResource } from "../../shared/api/useApiResource";
import { useEventStream } from "../../shared/api/useEventStream";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import { Icon } from "../../shared/ui/Icon";
import "./pages.css";

export function AgentRunPage() {
  const { runId } = useParams<{ runId: string }>();
  const [searchParams] = useSearchParams();
  const requestedReturn = searchParams.get("return_to");
  const returnTo =
    requestedReturn?.startsWith("/") && !requestedReturn.startsWith("//")
      ? requestedReturn
      : "/tasks";
  const returnLabel = returnTo.startsWith("/integrations")
    ? "返回迁移预览"
    : "返回任务中心";
  const [busyApproval, setBusyApproval] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<"interrupt" | "resume" | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const lastRefreshEvent = useRef(0);
  const resource = useApiResource(
    () =>
      runId
        ? Promise.all([api.agentRun(runId), api.approvals(runId)])
        : Promise.reject(new Error("运行地址无效")),
    [runId],
  );
  const stream = useEventStream<AgentEvent>(
    runId ? api.agentEventsUrl(runId) : null,
  );
  useEffect(() => {
    if (!runId) return;
    const timer = window.setInterval(() => void resource.reload(), 5_000);
    return () => window.clearInterval(timer);
  }, [resource.reload, runId]);
  useEffect(() => {
    const relevant = stream.events.findLast(
      (event) =>
        event.event_type.startsWith("approval.") ||
        ["run.completed", "run.failed", "run.canceled"].includes(
          event.event_type,
        ),
    );
    if (!relevant || relevant.id <= lastRefreshEvent.current) return;
    lastRefreshEvent.current = relevant.id;
    void resource.reload();
  }, [resource.reload, stream.events]);
  if (resource.loading)
    return <AsyncMessage kind="loading">正在恢复运行视图…</AsyncMessage>;
  if (resource.error)
    return (
      <AsyncMessage kind="error" onRetry={() => void resource.retry()}>
        {resource.error}
      </AsyncMessage>
    );
  if (!runId || !resource.data)
    return <AsyncMessage kind="empty">运行不存在</AsyncMessage>;
  const [run, approvals] = resource.data;

  async function decide(approval: Approval, decision: "approve" | "reject") {
    setBusyApproval(approval.id);
    setActionError(null);
    try {
      await (decision === "approve"
        ? api.approve(approval.id)
        : api.reject(approval.id));
      await resource.reload();
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : "无法保存审批决定",
      );
    } finally {
      setBusyApproval(null);
    }
  }

  async function control(action: "interrupt" | "resume") {
    setActionBusy(action);
    setActionError(null);
    try {
      await (action === "interrupt"
        ? api.interruptAgentRun(run.id)
        : api.resumeAgentRun(run.id));
      await resource.reload();
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : "无法更新运行状态",
      );
    } finally {
      setActionBusy(null);
    }
  }

  const active = [
    "created",
    "starting",
    "running",
    "waiting_approval",
    "cancellation_requested",
  ].includes(run.status);
  return (
    <section className="agent-run-page workspace-page">
      <div className="workspace-content">
        <header className="run-page-header">
          <Link to={returnTo}>
            <Icon name="arrow-left" size={16} />
            {returnLabel}
          </Link>
          <div>
            {active ? (
              <button
                className="danger-button"
                disabled={actionBusy !== null}
                type="button"
                onClick={() => void control("interrupt")}
              >
                <Icon name="close" size={15} />
                {actionBusy === "interrupt" ? "正在中断…" : "中断运行"}
              </button>
            ) : run.status === "failed" || run.status === "canceled" ? (
              <button
                className="toolbar-button"
                disabled={actionBusy !== null}
                type="button"
                onClick={() => void control("resume")}
              >
                <Icon name="refresh" size={15} />
                {actionBusy === "resume" ? "恢复中…" : "恢复运行"}
              </button>
            ) : null}
          </div>
        </header>
        {actionError ? (
          <p className="page-error" role="alert">
            {actionError}
          </p>
        ) : null}
        <AgentRunTimeline
          run={run}
          events={stream.events}
          approvals={approvals}
          streamState={stream.state}
          busyApproval={busyApproval}
          onApproval={decide}
        />
      </div>
    </section>
  );
}
