import { useState } from "react";

import { api } from "../../shared/api/client";
import type { ChangeItem, ChangeSet } from "../../shared/api/contracts";
import { formatDateTime } from "../../shared/lib/format";
import { Icon } from "../../shared/ui/Icon";
import "./changes.css";

interface Props {
  changeSet: ChangeSet;
  onChanged: () => Promise<unknown>;
}

const kindLabels: Record<ChangeSet["kind"], string> = {
  metadata_patch: "元数据修订",
  resource_acquisition: "资源获取",
  project_insights: "项目洞察",
  zotero_conflict_resolution: "Zotero 冲突建议",
};

export function ChangeSetReview({ changeSet, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const approved = changeSet.items.filter((item) => item.status === "approved").length;

  async function decide(item: ChangeItem, decision: "approve" | "reject") {
    setBusy(item.id);
    setError(null);
    try {
      await api.reviewChangeSet(changeSet.id, changeSet.content_hash, [
        { change_item_id: item.id, decision },
      ]);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存审阅决定");
    } finally {
      setBusy(null);
    }
  }

  async function applyApproved() {
    setBusy("apply");
    setError(null);
    try {
      await api.applyChangeSet(changeSet.id, changeSet.content_hash);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法应用已批准的变更");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="change-review">
      <header>
        <div>
          <span className="eyebrow">REVIEWED CHANGE SET</span>
          <h2>{changeSet.summary}</h2>
          <p>
            {kindLabels[changeSet.kind]} · {formatDateTime(changeSet.created_at)}
            {changeSet.agent_run_id ? " · 智能体建议" : " · 手动建议"}
          </p>
        </div>
        <span className={`run-status run-status--${changeSet.status}`}>
          <i />{changeSet.status}
        </span>
      </header>
      <div className="change-safety-note">
        <Icon name="shield" size={16} />
        <span>建议本身不会修改文献。每一项都要明确批准，应用时还会重新核对基线版本。</span>
      </div>
      {error ? <p className="change-error">{error}</p> : null}
      <div className="change-item-list">
        {changeSet.items.map((item) => (
          <article className={`change-item change-item--${item.status}`} key={item.id}>
            <header>
              <div>
                <span>{operationLabel(item.operation)}</span>
                <strong>{item.target_type}:{item.target_id}</strong>
              </div>
              <em>{item.status}</em>
            </header>
            <ChangePayload item={item} />
            {item.rationale ? <p className="change-rationale">{item.rationale}</p> : null}
            {item.evidence.length ? (
              <div className="change-evidence">
                {item.evidence.map((evidence, index) =>
                  evidence.url ? (
                    <a href={evidence.url} key={`${evidence.source}-${index}`} target="_blank" rel="noreferrer">
                      <Icon name="external-link" size={14} />
                      {evidence.source}{evidence.locator ? ` · ${evidence.locator}` : ""}
                    </a>
                  ) : (
                    <span key={`${evidence.source}-${index}`}>{evidence.source}</span>
                  ),
                )}
              </div>
            ) : null}
            {item.error_message ? <p className="change-item-error">{item.error_message}</p> : null}
            {item.result ? <ResultSummary result={item.result} /> : null}
            {!(["applied", "stale"] as const).includes(item.status as "applied" | "stale") ? (
              <div className="change-item-actions">
                <button
                  className={item.status === "approved" ? "approve active" : "approve"}
                  disabled={busy !== null}
                  type="button"
                  onClick={() => void decide(item, "approve")}
                >
                  <Icon name="check" size={16} />批准
                </button>
                <button
                  className={item.status === "rejected" ? "reject active" : "reject"}
                  disabled={busy !== null}
                  type="button"
                  onClick={() => void decide(item, "reject")}
                >
                  <Icon name="close" size={16} />拒绝
                </button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
      {approved ? (
        <footer>
          <span>已批准 {approved} 项；应用后仍保留完整修订与审计记录。</span>
          <button className="primary-button" disabled={busy !== null} type="button" onClick={() => void applyApproved()}>
            <Icon name="check" size={16} />{busy === "apply" ? "正在应用…" : `应用 ${approved} 项`}
          </button>
        </footer>
      ) : null}
    </div>
  );
}

function operationLabel(operation: string) {
  return ({
    "metadata.patch": "书目字段修改",
    "resource.acquire": "获取附件",
    "project.insight.patch": "项目阅读信息",
    "zotero.conflict.resolve": "Zotero 冲突选择",
  } as Record<string, string>)[operation] ?? operation;
}

function ChangePayload({ item }: { item: ChangeItem }) {
  const root = item.payload as Record<string, unknown>;
  const value = root.patch ?? root.request ?? root.resolution ?? root;
  return <pre className="change-payload">{JSON.stringify(value, null, 2)}</pre>;
}

function ResultSummary({ result }: { result: Record<string, unknown> }) {
  return (
    <p className="change-result">
      <Icon name="check" size={14} />
      {result.job_id ? `已建立任务 ${String(result.job_id)}` : "已由领域服务应用"}
    </p>
  );
}
