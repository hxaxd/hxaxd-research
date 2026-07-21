import type { AgentEvent, AgentRun, Approval } from "../../shared/api/contracts";
import { formatDateTime } from "../../shared/lib/format";
import { Icon } from "../../shared/ui/Icon";
import { ApprovalCard } from "./ApprovalCard";

interface Props {
  run: AgentRun;
  events: AgentEvent[];
  approvals: Approval[];
  streamState: string;
  busyApproval: string | null;
  onApproval: (approval: Approval, decision: "approve" | "reject") => Promise<void>;
}

export function AgentRunTimeline({ run, events, approvals, streamState, busyApproval, onApproval }: Props) {
  const visibleEvents = events.filter((event) => event.visibility === "public");
  return <div className="agent-timeline"><header><div><span className="eyebrow">AGENT RUN</span><h2>{run.goal}</h2></div><span className={`run-status run-status--${run.status}`}><i />{runStatusLabel(run.status)}</span></header><div className="timeline-meta"><span>{run.task_kind}</span><span>{run.runtime}{run.runtime_version ? ` ${run.runtime_version}` : ""}</span><span>{run.model || "默认模型"}</span><span>推理 {run.reasoning_effort || "默认"}</span><span className={`stream-state stream-state--${streamState}`}>事件流：{streamState}</span></div><div className="timeline-events">{approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} busy={busyApproval === approval.id} onApprove={() => onApproval(approval, "approve")} onReject={() => onApproval(approval, "reject")} />)}{visibleEvents.map((event) => <article className="timeline-event" key={event.id}><span className="timeline-marker"><Icon name={eventIcon(event.event_type)} size={14} /></span><div><div><strong>{eventLabel(event.event_type)}</strong><time>{formatDateTime(event.created_at)}</time></div><EventPayload payload={event.payload} /></div></article>)}{!visibleEvents.length && !approvals.length ? <div className="timeline-empty">运行事件将在这里实时出现。</div> : null}</div>{run.final_message ? <div className="run-final-message"><Icon name="check" size={16} /><p>{run.final_message}</p></div> : null}{run.error_message ? <div className="run-error"><Icon name="close" size={16} /><p>{run.error_message}</p></div> : null}</div>;
}

function EventPayload({ payload }: { payload: AgentEvent["payload"] }) {
  const summary = [payload.summary, payload.message, payload.title, payload.query].find((value) => typeof value === "string");
  return summary ? <p>{String(summary)}</p> : Object.keys(payload).length ? <details><summary>查看结构化事件</summary><pre>{JSON.stringify(payload, null, 2)}</pre></details> : null;
}

export function eventLabel(type: string) {
  if (type.startsWith("tool.")) return type.endsWith("completed") ? "工具调用完成" : type.endsWith("failed") ? "工具调用失败" : "正在调用工具";
  if (type.startsWith("approval.")) return type.endsWith("requested") ? "请求用户批准" : "审批已处理";
  if (type.includes("evidence")) return "发现新的来源证据";
  if (type.includes("plan")) return "计划已更新";
  if (type.startsWith("run.")) return `运行状态：${type.slice(4)}`;
  return type.replaceAll(".", " ");
}

function eventIcon(type: string): "terminal" | "shield" | "external-link" | "activity" {
  if (type.startsWith("tool.")) return "terminal";
  if (type.startsWith("approval.")) return "shield";
  if (type.includes("evidence")) return "external-link";
  return "activity";
}

function runStatusLabel(status: AgentRun["status"]) {
  return ({ created: "已创建", starting: "正在启动", running: "运行中", waiting_approval: "等待批准", cancellation_requested: "正在取消", canceled: "已取消", completed: "已完成", failed: "失败" } as const)[status];
}
