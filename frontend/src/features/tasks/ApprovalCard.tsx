import type { Approval } from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";

interface Props {
  approval: Approval;
  busy: boolean;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
}

export function ApprovalCard({ approval, busy, onApprove, onReject }: Props) {
  const summary = valueText(approval.request.summary) || valueText(approval.request.command) || approval.kind;
  return <article className={`approval-card approval-card--${approval.status}`}><div className="approval-icon"><Icon name="shield" size={18} /></div><div className="approval-copy"><span>需要你的批准</span><strong>{summary}</strong><pre>{JSON.stringify(approval.request, null, 2)}</pre></div>{approval.status === "pending" ? <div className="approval-actions"><button type="button" disabled={busy} onClick={() => void onReject()}>拒绝</button><button className="primary-button" type="button" disabled={busy || !approval.approvable} onClick={() => void onApprove()}>批准</button></div> : <span className="approval-result">{approval.status}</span>}</article>;
}

function valueText(value: unknown) {
  return typeof value === "string" ? value : "";
}
