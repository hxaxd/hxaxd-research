import { useMemo, useState } from "react";

import type { Candidate, CandidateDecision } from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";
import "./candidates.css";

interface Props {
  candidates: Candidate[];
  deciding: string | null;
  onDecision: (decision: CandidateDecision) => Promise<void>;
}

export function CandidateInbox({ candidates, deciding, onDecision }: Props) {
  const pending = useMemo(
    () => candidates.filter((item) => item.state === "staged" || item.state === "matched"),
    [candidates],
  );
  const [selectedId, setSelectedId] = useState<string | null>(pending[0]?.id ?? null);
  const selected = pending.find((item) => item.id === selectedId) ?? pending[0] ?? null;

  if (!pending.length) {
    return <div className="candidate-empty"><span><Icon name="inbox" size={24} /></span><h2>候选收件箱已清空</h2><p>新的检索结果会先进入这里，不会自动改变项目收录状态。</p></div>;
  }

  return (
    <div className="candidate-workspace">
      <section className="candidate-list" aria-label="待判断候选">
        <header><div><span className="eyebrow">CANDIDATE INBOX</span><h2>等待你的判断</h2></div><strong>{pending.length}</strong></header>
        {pending.map((candidate) => (
          <button
            className={candidate.id === selected?.id ? "candidate-row candidate-row--selected" : "candidate-row"}
            key={candidate.id}
            type="button"
            onClick={() => setSelectedId(candidate.id)}
          >
            <span className="candidate-rank">{candidate.rank === null ? "—" : Math.round(candidate.rank * 100)}</span>
            <span className="candidate-row-copy"><strong>{candidate.item.translated_title || candidate.item.title}</strong><small>{candidate.item.title}</small><em>{creatorLine(candidate)} · {candidate.item.issued_year ?? "年份未知"}</em></span>
            {candidate.matched_work_id ? <span className="match-badge">可能重复</span> : null}
          </button>
        ))}
      </section>
      {selected ? <CandidateInspector key={selected.id} candidate={selected} busy={deciding === selected.id} onDecision={onDecision} /> : null}
    </div>
  );
}

function CandidateInspector({ candidate, busy, onDecision }: { candidate: Candidate; busy: boolean; onDecision: Props["onDecision"] }) {
  const [reason, setReason] = useState("");
  return (
    <aside className="candidate-inspector">
      <div className="candidate-inspector-scroll">
        <span className="eyebrow">REVIEW</span>
        <h2>{candidate.item.translated_title || candidate.item.title}</h2>
        {candidate.item.translated_title ? <p className="candidate-original-title">{candidate.item.title}</p> : null}
        <div className="candidate-facts"><span>{candidate.item.item_type}</span><span>{candidate.item.issued_year ?? "年份未知"}</span><span>{candidate.item.container_title || "来源未知"}</span></div>
        <section><h3>发现理由</h3><p>{candidate.rationale || "该检索任务没有提供额外的推荐理由。"}</p></section>
        <section><h3>摘要</h3><p>{candidate.item.abstract || "尚未获取摘要。可以先根据来源证据判断，或交给智能体补全元数据。"}</p></section>
        <section><h3>来源证据</h3><EvidenceList candidate={candidate} /></section>
        {candidate.matched_work_id ? <div className="candidate-warning"><Icon name="shield" size={16} /><div><strong>发现可能重复的文献</strong><p>收录时将使用匹配项，不会静默新建重复记录。</p></div></div> : null}
      </div>
      <div className="candidate-decision-bar">
        <label><span>判断备注（可选）</span><textarea value={reason} placeholder="记录收录或排除的理由" onChange={(event) => setReason(event.target.value)} /></label>
        <div><button className="decision-secondary" type="button" disabled={busy} onClick={() => void onDecision({ candidate_id: candidate.id, decision: "exclude", reason: reason.trim() || null })}><Icon name="close" size={15} />不收录</button><button className="primary-button" type="button" disabled={busy} onClick={() => void onDecision({ candidate_id: candidate.id, decision: "include", matched_work_id: candidate.matched_work_id, reason: reason.trim() || null })}><Icon name="check" size={15} />{busy ? "正在提交…" : "收入项目"}</button></div>
      </div>
    </aside>
  );
}

function EvidenceList({ candidate }: { candidate: Candidate }) {
  const evidence = candidate.evidence ?? [];
  if (!evidence.length) {
    return <div className="evidence-card"><Icon name="external-link" size={15} /><div><strong>{candidate.source_record_id ? "来源记录已保存" : "没有附加证据"}</strong><p>{candidate.source_record_id || "建议在收录前补充来源。"}</p></div></div>;
  }
  return <div className="evidence-list">{evidence.map((item) => <article className="evidence-card" key={item.id}><Icon name="external-link" size={15} /><div><strong>{item.provider}{item.external_key ? ` · ${item.external_key}` : ""}</strong><p>{item.summary || "结构化来源记录"}</p>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">打开原始来源</a> : null}</div></article>)}</div>;
}

function creatorLine(candidate: Candidate) {
  const names = candidate.item.creators.slice(0, 3).map((creator) => creator.literal_name || [creator.given_name, creator.family_name].filter(Boolean).join(" ") || creator.raw_name);
  return names.join(", ") || "作者未知";
}
