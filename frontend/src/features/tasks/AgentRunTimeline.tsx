import type { AgentEvent, AgentRun, Approval } from "../../shared/api/contracts";
import { formatDateTime } from "../../shared/lib/format";
import { Icon } from "../../shared/ui/Icon";
import { agentRuntimeLabel } from "../agents/AgentRuntimePicker";
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
  const visibleEvents = compactEvents(events.filter((event) =>
    event.visibility === "public" && meaningfulEvent(event.event_type),
  ));
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const approvalHistory = approvals.filter((approval) => approval.status !== "pending");
  return <div className="agent-timeline">
    <header><div><span className="eyebrow">智能体任务</span><h2>{run.goal}</h2></div><span className={`run-status run-status--${run.status}`}><i />{runStatusLabel(run.status)}</span></header>
    {run.final_message ? <section className="run-final-message run-final-message--primary"><Icon name="check" size={18} /><div><strong>运行结果</strong><p>{run.final_message}</p></div></section> : null}
    {run.error_message ? <div className="run-error"><Icon name="close" size={16} /><div><strong>运行未完成</strong><p>{run.error_message}</p></div></div> : null}
    <div className="timeline-meta"><span className="timeline-runtime"><Icon name="terminal" size={13} />{agentRuntimeLabel(run.runtime)}</span><span>{taskLabel(run.task_kind)}</span><span>{run.model || "跟随运行环境"}</span><span className={`stream-state stream-state--${streamState}`}>{streamStateLabel(streamState)}</span><details><summary>系统诊断</summary><p>{agentRuntimeLabel(run.runtime)}{run.runtime_version ? ` ${run.runtime_version}` : ""} · 推理强度 {run.reasoning_effort || "默认"}</p></details></div>
    <div className="timeline-events">
      {pendingApprovals.map((approval) => <ApprovalCard key={approval.id} approval={approval} busy={busyApproval === approval.id} onApprove={() => onApproval(approval, "approve")} onReject={() => onApproval(approval, "reject")} />)}
      {visibleEvents.map((event) => <article className="timeline-event" key={event.id}><span className="timeline-marker"><Icon name={eventIcon(event.event_type)} size={14} /></span><div><div><strong>{eventLabel(event.event_type)}</strong><time>{formatDateTime(event.created_at)}</time></div><EventPayload event={event} /></div></article>)}
      {!visibleEvents.length && !pendingApprovals.length ? <div className="timeline-empty">{run.final_message ? "运行过程已归档；上方是最终结果。" : "正在等待第一个可见进展。"}</div> : null}
      {approvalHistory.length ? <details className="approval-history"><summary>历史审批（{approvalHistory.length}）</summary>{approvalHistory.map((approval) => <ApprovalCard key={approval.id} approval={approval} busy={false} onApprove={() => Promise.resolve()} onReject={() => Promise.resolve()} />)}</details> : null}
    </div>
  </div>;
}

function EventPayload({ event }: { event: AgentEvent }) {
  const payload = event.payload;
  const summary = [payload.summary, payload.message, payload.title, payload.query, payload.status].find((value) => typeof value === "string");
  if (summary) return <p>{String(summary)}</p>;
  const tool = [payload.tool_name, payload.tool, payload.name].find((value) => typeof value === "string");
  if (tool) return <p>工具：{String(tool)}</p>;
  return null;
}

export function eventLabel(type: string) {
  if (type.startsWith("tool.")) return type.endsWith("completed") ? "工具调用完成" : type.endsWith("failed") ? "工具调用失败" : "正在调用工具";
  if (type.startsWith("approval.")) return type.endsWith("requested") ? "请求用户批准" : "审批已处理";
  if (type.includes("evidence")) return "发现新的来源证据";
  if (type.includes("plan")) return "计划已更新";
  if (type === "run.created") return "任务已创建";
  if (type === "run.enqueue_requested") return "已加入执行队列";
  if (type === "run.resumed") return "运行已恢复";
  if (type === "run.completed") return "运行完成";
  if (type === "run.failed") return "运行失败";
  if (type === "run.canceled") return "运行已取消";
  if (type.startsWith("agent.message")) return "智能体更新";
  return "运行进展";
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

function meaningfulEvent(type: string) {
  if (type.endsWith(".delta") || type.includes("reasoning") || type.startsWith("item.")) return false;
  if (type === "approval.resolved") return false;
  return type.startsWith("run.")
    || type.startsWith("tool.")
    || type.startsWith("approval.")
    || type.startsWith("agent.message")
    || type.includes("evidence")
    || type.includes("plan")
    || type.startsWith("web_search.");
}

function compactEvents(events: AgentEvent[]) {
  const result: AgentEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    if (previous && previous.event_type === event.event_type && eventSummary(previous) === eventSummary(event)) {
      result[result.length - 1] = event;
    } else {
      result.push(event);
    }
  }
  return result.slice(-80);
}

function eventSummary(event: AgentEvent) {
  return [event.payload.summary, event.payload.message, event.payload.title, event.payload.query]
    .find((value) => typeof value === "string") ?? "";
}

function streamStateLabel(state: string) {
  return ({ idle: "尚未连接", connecting: "正在自动续接", open: "进展实时更新", closed: "运行记录已结束", error: "实时连接中断，正在重试" } as Record<string, string>)[state] ?? "正在更新";
}

function taskLabel(kind: string) {
  return ({ literature_search: "检索候选文献", metadata_enrichment: "补全文献元数据", metadata_completion: "补全文献元数据", resource_acquisition: "寻找文献资源", conflict_resolution: "分析 Zotero 冲突", zotero_conflict_resolution: "分析 Zotero 冲突" } as Record<string, string>)[kind] ?? "智能体任务";
}
