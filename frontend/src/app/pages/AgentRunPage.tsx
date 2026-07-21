import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

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
  const [busyApproval, setBusyApproval] = useState<string | null>(null);
  const lastRefreshEvent = useRef(0);
  const resource = useApiResource(
    () => runId ? Promise.all([api.agentRun(runId), api.approvals(runId)]) : Promise.reject(new Error("运行地址无效")),
    [runId],
  );
  const stream = useEventStream<AgentEvent>(runId ? api.agentEventsUrl(runId) : null);
  useEffect(() => {
    const relevant = stream.events.findLast((event) =>
      event.event_type.startsWith("approval.") || ["run.completed", "run.failed", "run.canceled"].includes(event.event_type)
    );
    if (!relevant || relevant.id <= lastRefreshEvent.current) return;
    lastRefreshEvent.current = relevant.id;
    void resource.reload();
  }, [resource.reload, stream.events]);
  if (resource.loading) return <AsyncMessage kind="loading">正在恢复运行视图…</AsyncMessage>;
  if (resource.error) return <AsyncMessage kind="error" onRetry={() => void resource.retry()}>{resource.error}</AsyncMessage>;
  if (!runId || !resource.data) return <AsyncMessage kind="empty">运行不存在</AsyncMessage>;
  const [run, approvals] = resource.data;

  async function decide(approval: Approval, decision: "approve" | "reject") {
    setBusyApproval(approval.id);
    try {
      await (decision === "approve" ? api.approve(approval.id) : api.reject(approval.id));
      await resource.reload();
    } finally {
      setBusyApproval(null);
    }
  }

  const active = ["created", "starting", "running", "waiting_approval", "cancellation_requested"].includes(run.status);
  return <section className="workspace-page"><div className="workspace-content"><header className="run-page-header"><Link to="/tasks"><Icon name="arrow-left" size={16} />返回任务中心</Link><div>{active ? <button className="danger-button" type="button" onClick={() => void api.interruptAgentRun(run.id).then(resource.reload)}><Icon name="close" size={15} />中断运行</button> : run.status === "failed" || run.status === "canceled" ? <button className="toolbar-button" type="button" onClick={() => void api.resumeAgentRun(run.id).then(resource.reload)}><Icon name="refresh" size={15} />恢复运行</button> : null}</div></header><AgentRunTimeline run={run} events={stream.events} approvals={approvals} streamState={stream.state} busyApproval={busyApproval} onApproval={decide} /></div></section>;
}
