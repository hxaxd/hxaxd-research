import type { Approval } from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";

interface Props {
  approval: Approval;
  busy: boolean;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
}

export function ApprovalCard({ approval, busy, onApprove, onReject }: Props) {
  const summary = approvalSummary(approval);
  const command = commandText(approval.request.command);
  return <article className={`approval-card approval-card--${approval.status}`}><div className="approval-icon"><Icon name="shield" size={18} /></div><div className="approval-copy"><span>{approval.status === "pending" ? "需要你的决定" : "审批记录"}</span><strong>{summary}</strong>{command ? <code>{command}</code> : null}{approval.kind === "permissions" ? <p>运行请求了超出任务边界的权限，系统已禁止在这里放行。</p> : null}</div>{approval.status === "pending" ? <div className="approval-actions"><button type="button" disabled={busy} onClick={() => void onReject()}>{busy ? "处理中…" : "拒绝"}</button><button className="primary-button" type="button" disabled={busy || !approval.approvable} onClick={() => void onApprove()}>{busy ? "处理中…" : "批准一次"}</button></div> : <span className="approval-result">{approvalStatusLabel(approval.status)}</span>}</article>;
}

function approvalSummary(approval: Approval) {
  const reason = valueText(approval.request.reason) || valueText(approval.request.summary);
  if (reason) return reason;
  return ({ command: "允许执行这条命令", file_change: "允许修改工作区文件", permissions: "请求额外运行权限" } as Record<string, string>)[approval.kind] ?? "允许本次受控操作";
}

function commandText(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(" ");
  return "";
}

function valueText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function approvalStatusLabel(status: Approval["status"]) {
  return ({ pending: "等待决定", approved: "已批准", denied: "已拒绝", expired: "已过期" } as const)[status];
}
