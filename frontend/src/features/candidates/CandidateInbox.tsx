import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import type {
  BibliographicItem,
  Candidate,
  CandidateDecision,
  CandidateDraft,
} from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";
import "./candidates.css";

interface Props {
  candidates: Candidate[];
  deciding: string | "batch" | null;
  onDecisions: (
    decisions: CandidateDecision[],
    options?: { openIncluded?: boolean },
  ) => Promise<void>;
}

export interface CandidateDifference {
  label: string;
  proposed: string;
  existing: string;
  equal: boolean;
}

export function candidateDifferences(candidate: Candidate): CandidateDifference[] {
  const existing = candidate.matched_item;
  if (!existing) return [];
  return [
    difference("标题", candidate.item.title, existing.title),
    difference("年份", text(candidate.item.issued_year), text(existing.issued_year)),
    difference("出版来源", text(candidate.item.container_title), text(existing.container_title)),
    difference("作者", candidateCreatorLine(candidate.item), existingCreatorLine(existing)),
    difference(
      "标识符",
      candidate.item.identifiers.map((item) => `${item.scheme}:${item.value}`).join(" · "),
      existing.identifiers.map((item) => `${item.scheme}:${item.value}`).join(" · "),
    ),
  ];
}

export function nextCandidateId(
  candidates: Candidate[],
  selectedId: string | null,
  direction: -1 | 1,
) {
  if (!candidates.length) return null;
  const current = Math.max(0, candidates.findIndex((item) => item.id === selectedId));
  const next = Math.min(candidates.length - 1, Math.max(0, current + direction));
  return candidates[next]?.id ?? candidates[0]?.id ?? null;
}

export function CandidateInbox({ candidates, deciding, onDecisions }: Props) {
  const pending = useMemo(
    () => candidates.filter((item) => item.state === "staged" || item.state === "matched"),
    [candidates],
  );
  const [selectedId, setSelectedId] = useState<string | null>(pending[0]?.id ?? null);
  const [inspectorOpen, setInspectorOpen] = useState(
    () => !window.matchMedia("(max-width: 940px)").matches,
  );
  const [batchSelection, setBatchSelection] = useState<Set<string>>(new Set());
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const selected = pending.find((item) => item.id === selectedId) ?? pending[0] ?? null;
  const selectedBatch = pending.filter((item) => batchSelection.has(item.id));
  const busy = deciding !== null;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 940px)");
    const syncInspector = () => setInspectorOpen(!media.matches);
    media.addEventListener("change", syncInspector);
    return () => media.removeEventListener("change", syncInspector);
  }, []);

  function selectCandidate(candidateId: string) {
    setSelectedId(candidateId);
    setInspectorOpen(true);
  }

  function decision(candidate: Candidate, value: CandidateDecision["decision"]): CandidateDecision {
    return {
      candidate_id: candidate.id,
      decision: value,
      matched_work_id: value === "include" ? candidate.matched_work_id : null,
      reason: reasons[candidate.id]?.trim() || null,
    };
  }

  function submitSingle(value: CandidateDecision["decision"]) {
    if (!selected || busy) return;
    void onDecisions([decision(selected, value)], { openIncluded: value === "include" });
  }

  async function submitBatch(value: CandidateDecision["decision"]) {
    if (!selectedBatch.length || busy) return;
    await onDecisions(selectedBatch.map((candidate) => decision(candidate, value)));
    setBatchSelection(new Set());
  }

  function toggleBatch(candidateId: string) {
    setBatchSelection((current) => {
      const next = new Set(current);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  }

  function handleKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (isInteractive(event.target) || busy) return;
    const key = event.key.toLocaleLowerCase();
    if (["arrowdown", "j"].includes(key)) {
      event.preventDefault();
      setSelectedId(nextCandidateId(pending, selected?.id ?? null, 1));
    } else if (["arrowup", "k"].includes(key)) {
      event.preventDefault();
      setSelectedId(nextCandidateId(pending, selected?.id ?? null, -1));
    } else if (key === "i") {
      event.preventDefault();
      submitSingle("include");
    } else if (key === "x") {
      event.preventDefault();
      submitSingle("exclude");
    }
  }

  if (!pending.length) {
    return <div className="candidate-empty"><span><Icon name="inbox" size={24} /></span><h2>候选收件箱已清空</h2><p>新的检索结果会先进入这里，不会自动改变项目收录状态。</p></div>;
  }

  return (
    <div
      className="candidate-workspace"
      onKeyDown={handleKeyboard}
      tabIndex={0}
      aria-label="候选审阅工作区，方向键或 J K 切换，I 收录，X 排除"
    >
      <section className="candidate-list" aria-label="待判断候选">
        <header>
          <div><span className="eyebrow">候选收件箱</span><h2>等待你的判断</h2></div>
          <div className="candidate-list-summary">
            <button
              type="button"
              disabled={busy}
              onClick={() => setBatchSelection(
                batchSelection.size === pending.length
                  ? new Set()
                  : new Set(pending.map((item) => item.id)),
              )}
            >{batchSelection.size === pending.length ? "清空" : "全选"}</button>
            <strong>{pending.length}</strong>
          </div>
        </header>
        {selectedBatch.length ? <div className="candidate-batch-bar" role="status">
          <span>已选 {selectedBatch.length} 条；每条使用各自填写的判断备注。</span>
          <div>
            <button type="button" disabled={busy} onClick={() => void submitBatch("exclude")}>批量排除</button>
            <button className="primary-button" type="button" disabled={busy} onClick={() => void submitBatch("include")}>{deciding === "batch" ? "提交中…" : "批量收录"}</button>
          </div>
        </div> : null}
        {pending.map((candidate) => (
          <div
            className={candidate.id === selected?.id ? "candidate-row candidate-row--selected" : "candidate-row"}
            key={candidate.id}
          >
            <button
              aria-label={`${batchSelection.has(candidate.id) ? "取消选择" : "选择"} ${candidate.item.title}`}
              aria-pressed={batchSelection.has(candidate.id)}
              className="candidate-batch-toggle"
              type="button"
              disabled={busy}
              onClick={() => toggleBatch(candidate.id)}
            ><Icon name="check" size={15} /></button>
            <button className="candidate-row-main" type="button" onClick={() => selectCandidate(candidate.id)}>
              <span className="candidate-rank" title="来源结果中的顺序；数字越小越靠前">
                {candidateRankLabel(candidate.rank)}
              </span>
              <span className="candidate-row-copy"><strong>{candidate.item.translated_title || candidate.item.title}</strong><small>{candidate.item.title}</small><em>{candidateCreatorLine(candidate.item)} · {candidate.item.issued_year ?? "年份未知"}</em></span>
              {candidate.matched_work_id ? <span className="match-badge">可能重复</span> : null}
            </button>
          </div>
        ))}
      </section>
      {selected ? <CandidateInspector
        key={selected.id}
        candidate={selected}
        open={inspectorOpen}
        busy={busy}
        reason={reasons[selected.id] ?? ""}
        onReason={(reason) => setReasons((current) => ({ ...current, [selected.id]: reason }))}
        onDecision={submitSingle}
        onClose={() => setInspectorOpen(false)}
      /> : null}
    </div>
  );
}

function CandidateInspector({ candidate, open, busy, reason, onReason, onDecision, onClose }: {
  candidate: Candidate;
  open: boolean;
  busy: boolean;
  reason: string;
  onReason: (reason: string) => void;
  onDecision: (decision: CandidateDecision["decision"]) => void;
  onClose: () => void;
}) {
  const differences = candidateDifferences(candidate);
  return (
    <aside aria-hidden={!open} className={open ? "candidate-inspector candidate-inspector--open" : "candidate-inspector"}>
      <button aria-label="关闭候选详情" className="candidate-inspector-close" type="button" onClick={onClose}><Icon name="close" size={17} /></button>
      <div className="candidate-inspector-scroll">
        <span className="eyebrow">逐项判断</span>
        <h2>{candidate.item.translated_title || candidate.item.title}</h2>
        {candidate.item.translated_title ? <p className="candidate-original-title">{candidate.item.title}</p> : null}
        <div className="candidate-facts"><span>{candidate.item.item_type}</span><span>{candidate.item.issued_year ?? "年份未知"}</span><span>{candidate.item.container_title || "来源未知"}</span>{candidate.item.identifiers.map((identifier) => <span key={`${identifier.scheme}:${identifier.value}`}>{identifier.scheme.toUpperCase()} {identifier.value}</span>)}</div>
        <section><h3>发现理由</h3><p>{candidate.rationale || "该检索任务没有提供额外的推荐理由。"}</p></section>
        <section><h3>摘要</h3><p>{candidate.item.abstract || "尚未获取摘要。可以先根据来源证据判断，或交给智能体补全元数据。"}</p></section>
        <section><h3>来源证据</h3><EvidenceList candidate={candidate} /></section>
        {differences.length ? <section className="candidate-match-comparison">
          <h3>与现有文献的关键字段对比</h3>
          <div role="table" aria-label="重复项字段对比">
            <div className="candidate-diff-row candidate-diff-header" role="row"><span>字段</span><span>候选值</span><span>现有值</span></div>
            {differences.map((item) => <div className={item.equal ? "candidate-diff-row candidate-diff-row--same" : "candidate-diff-row candidate-diff-row--changed"} role="row" key={item.label}><strong>{item.label}</strong><span>{item.proposed}</span><span>{item.existing}</span></div>)}
          </div>
          <div className="candidate-warning"><Icon name="shield" size={16} /><div><strong>收录时复用现有文献</strong><p>不会静默创建重复书目；不同字段保留在来源证据中供后续元数据补全。</p></div></div>
        </section> : null}
      </div>
      <div className="candidate-decision-bar">
        <label><span>判断备注（批量选择时按候选分别保存）</span><textarea value={reason} placeholder="记录收录或排除的理由" onChange={(event) => onReason(event.target.value)} /></label>
        <div><span className="candidate-shortcuts">J/K 切换 · I 收录 · X 排除</span><button aria-keyshortcuts="X" className="decision-secondary" type="button" disabled={busy} onClick={() => onDecision("exclude")}><Icon name="close" size={15} />不收录</button><button aria-keyshortcuts="I" className="primary-button" type="button" disabled={busy} onClick={() => onDecision("include")}><Icon name="check" size={15} />{busy ? "正在提交…" : "收入项目"}</button></div>
      </div>
    </aside>
  );
}

function EvidenceList({ candidate }: { candidate: Candidate }) {
  const evidence = candidate.evidence ?? [];
  if (!evidence.length) {
    return <div className="evidence-card"><Icon name="external-link" size={15} /><div><strong>{candidate.source_record_id ? "来源记录已保存" : "没有附加证据"}</strong><p>{candidate.source_record_id || "建议在收录前补充来源。"}</p></div></div>;
  }
  return <div className="evidence-list">{evidence.map((item) => <article className="evidence-card" key={item.id}><Icon name="external-link" size={15} /><div><strong>{item.provider}{item.external_key ? ` · ${item.external_key}` : ""}</strong><p>{item.summary || "结构化来源记录"}</p><p>{item.captured_at ? `抓取于 ${new Date(item.captured_at).toLocaleString("zh-CN")}` : "抓取时间未知"}</p>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">打开原始来源</a> : null}</div></article>)}</div>;
}

function candidateCreatorLine(item: CandidateDraft) {
  return item.creators.slice(0, 5).map((creator) => creator.literal_name || [creator.given_name, creator.family_name].filter(Boolean).join(" ") || creator.raw_name).join(", ") || "作者未知";
}

function existingCreatorLine(item: BibliographicItem) {
  return item.creators.slice(0, 5).map((creator) => creator.literal_name || [creator.given_name, creator.family_name].filter(Boolean).join(" ") || creator.raw_name).join(", ") || "作者未知";
}

function difference(label: string, proposed: string, existing: string): CandidateDifference {
  return { label, proposed: proposed || "—", existing: existing || "—", equal: normalize(proposed) === normalize(existing) };
}

function text(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function candidateRankLabel(rank: number | null) {
  if (rank === null) return "—";
  return `#${Math.max(1, Math.round(rank))}`;
}

function normalize(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function isInteractive(target: EventTarget) {
  return target instanceof HTMLElement && Boolean(target.closest("button, input, textarea, select, a"));
}
