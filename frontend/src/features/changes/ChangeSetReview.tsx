import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

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
  const approved = changeSet.items.filter(
    (item) => item.status === "approved" && !textValue(item.result?.job_id),
  ).length;

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
      setError(
        reason instanceof Error ? reason.message : "无法应用已批准的变更",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="change-review">
      <header>
        <div>
          <span className="eyebrow">待你审阅</span>
          <h2>{changeSet.summary}</h2>
          <p>
            {kindLabels[changeSet.kind]} ·{" "}
            {formatDateTime(changeSet.created_at)}
            {changeSet.agent_run_id ? " · 智能体建议" : " · 手动建议"}
          </p>
        </div>
        <span className={`run-status run-status--${changeSet.status}`}>
          <i />
          {changeSetStatusLabel(changeSet.status)}
        </span>
      </header>
      <div className="change-safety-note">
        <Icon name="shield" size={16} />
        <span>
          建议本身不会修改文献。每一项都要明确批准，应用时还会重新核对基线版本。
        </span>
      </div>
      {error ? <p className="change-error">{error}</p> : null}
      <div className="change-item-list">
        {changeSet.items.map((item) => (
          <article
            className={`change-item change-item--${item.status}`}
            key={item.id}
          >
            <header>
              <div>
                <span>{operationLabel(item.operation)}</span>
                <strong>{targetLabel(item)}</strong>
              </div>
              <em>{changeItemStatusLabel(item.status)}</em>
            </header>
            <ChangePayload item={item} />
            {item.rationale ? (
              <p className="change-rationale">{item.rationale}</p>
            ) : null}
            {item.evidence.length ? (
              <div className="change-evidence">
                {item.evidence.map((evidence, index) =>
                  evidence.url ? (
                    <a
                      href={evidence.url}
                      key={`${evidence.source}-${index}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icon name="external-link" size={14} />
                      {evidence.source}
                      {evidence.locator ? ` · ${evidence.locator}` : ""}
                    </a>
                  ) : (
                    <span key={`${evidence.source}-${index}`}>
                      {evidence.source}
                      {evidence.locator ? ` · ${evidence.locator}` : ""}
                    </span>
                  ),
                )}
              </div>
            ) : null}
            {item.error_message ? (
              <p className="change-item-error">{item.error_message}</p>
            ) : null}
            {item.result ? <ResultSummary result={item.result} /> : null}
            {!(["applied", "stale"] as const).includes(
              item.status as "applied" | "stale",
            ) ? (
              <div className="change-item-actions">
                <button
                  className={
                    item.status === "approved" ? "approve active" : "approve"
                  }
                  disabled={busy !== null}
                  type="button"
                  onClick={() => void decide(item, "approve")}
                >
                  <Icon name="check" size={16} />
                  批准
                </button>
                <button
                  className={
                    item.status === "rejected" ? "reject active" : "reject"
                  }
                  disabled={busy !== null}
                  type="button"
                  onClick={() => void decide(item, "reject")}
                >
                  <Icon name="close" size={16} />
                  拒绝
                </button>
              </div>
            ) : null}
          </article>
        ))}
      </div>
      {approved ? (
        <footer>
          <span>已批准 {approved} 项；应用后仍保留完整修订与审计记录。</span>
          <button
            className="primary-button"
            disabled={busy !== null}
            type="button"
            onClick={() => void applyApproved()}
          >
            <Icon name="check" size={16} />
            {busy === "apply" ? "正在应用…" : `应用 ${approved} 项`}
          </button>
        </footer>
      ) : null}
    </div>
  );
}

function operationLabel(operation: string) {
  return (
    (
      {
        "metadata.patch": "书目字段修改",
        "resource.acquire": "获取附件",
        "project.insight.patch": "项目阅读信息",
        "zotero.conflict.resolve": "Zotero 冲突选择",
      } as Record<string, string>
    )[operation] ?? operation
  );
}

function ChangePayload({ item }: { item: ChangeItem }) {
  if (item.operation === "metadata.patch") {
    return (
      <PayloadFields
        rows={objectRows(record(item.payload.patch), metadataFieldLabel)}
      />
    );
  }
  if (item.operation === "resource.acquire") {
    const request = record(item.payload.request);
    const url = textValue(request.url);
    return (
      <PayloadFields
        rows={[
          [
            "来源",
            url ? (
              <a href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            ) : (
              "未提供"
            ),
          ],
          ["保存名称", textValue(request.filename) || "沿用来源文件名"],
          ["资源类型", resourceTypeLabel(textValue(request.attachment_type))],
          ["语言版本", languageModeLabel(textValue(request.language_mode))],
          ["推荐用途", listValue(request.preferred_for)],
        ]}
      />
    );
  }
  if (item.operation === "project.insight.patch") {
    return (
      <PayloadFields
        rows={objectRows(record(item.payload.patch), insightFieldLabel)}
      />
    );
  }
  if (item.operation === "zotero.conflict.resolve") {
    const resolution = record(item.payload.resolution);
    const manual = record(resolution.manual_changes);
    return (
      <PayloadFields
        rows={[
          ["处理方式", conflictChoiceLabel(textValue(resolution.choice))],
          ...(Object.keys(manual).length
            ? objectRows(manual, metadataFieldLabel)
            : []),
        ]}
      />
    );
  }
  return <p className="change-payload-empty">这项建议没有可展示的领域字段。</p>;
}

function ResultSummary({ result }: { result: Record<string, unknown> }) {
  const jobId = textValue(result.job_id);
  const jobStatus = textValue(result.job_status);
  return (
    <p className="change-result">
      <Icon name="check" size={14} />
      {jobId ? (
        <>
          后台任务{jobStatus ? ` · ${jobStatusLabel(jobStatus)}` : ""}{" "}
          <Link to={`/tasks?job=${jobId}`}>查看进度</Link>
        </>
      ) : (
        "已由领域服务应用"
      )}
    </p>
  );
}

function PayloadFields({ rows }: { rows: Array<[string, ReactNode]> }) {
  return rows.length ? (
    <dl className="change-payload-fields">
      {rows.map(([label, value], index) => (
        <div key={`${label}-${index}`}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="change-payload-empty">没有字段变化。</p>
  );
}

function objectRows(
  value: Record<string, unknown>,
  label: (key: string) => string,
): Array<[string, ReactNode]> {
  return Object.entries(value).map(([key, field]) => [
    label(key),
    displayValue(field),
  ]);
}

function displayValue(value: unknown): ReactNode {
  if (value === null || value === "") return <em>清空</em>;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return listValue(value);
  const nested = record(value);
  const name =
    textValue(nested.literal_name) ||
    textValue(nested.raw_name) ||
    textValue(nested.name) ||
    textValue(nested.title);
  return name || `${Object.keys(nested).length} 个结构化字段`;
}

function listValue(value: unknown) {
  if (!Array.isArray(value) || !value.length) return "无";
  return value
    .map((entry) => {
      if (typeof entry === "string" || typeof entry === "number")
        return String(entry);
      const item = record(entry);
      return (
        textValue(item.literal_name) ||
        textValue(item.raw_name) ||
        textValue(item.name) ||
        textValue(item.title) ||
        "结构化条目"
      );
    })
    .join("、");
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function metadataFieldLabel(key: string) {
  return (
    (
      {
        item_type: "文献类型",
        title: "标题",
        short_title: "短标题",
        translated_title: "译名",
        abstract: "摘要",
        language: "语言",
        issued_year: "出版年",
        issued_month: "出版月",
        issued_day: "出版日",
        issued_literal: "出版日期",
        container_title: "期刊或文集",
        publisher: "出版者",
        place: "出版地",
        volume: "卷",
        issue: "期",
        pages: "页码",
        edition: "版本",
        series: "丛书",
        publication_state: "出版状态",
        creator_list_complete: "作者列表完整",
        creators: "作者",
        identifiers: "标识符",
        links: "相关链接",
        tags: "标签",
      } as Record<string, string>
    )[key] ?? key
  );
}

function insightFieldLabel(key: string) {
  return (
    (
      {
        roles: "在项目中的角色",
        summary: "项目摘要",
        relevance: "相关性",
        contributions: "主要贡献",
        reading_focus: "阅读重点",
      } as Record<string, string>
    )[key] ?? key
  );
}

function targetLabel(item: ChangeItem) {
  return (
    (
      {
        "metadata.patch": "当前文献的书目信息",
        "resource.acquire": "当前文献的新附件",
        "project.insight.patch": "当前项目中的阅读信息",
        "zotero.conflict.resolve": "一项 Zotero 同步冲突",
      } as Record<string, string>
    )[item.operation] ?? "工作区对象"
  );
}

function resourceTypeLabel(value: string) {
  return (
    (
      {
        fulltext: "全文",
        source_archive: "源码包",
        supplement: "补充材料",
        other: "其他附件",
      } as Record<string, string>
    )[value] ??
    (value || "未指定")
  );
}

function languageModeLabel(value: string) {
  return (
    (
      { original: "原文", translated: "译文", bilingual: "双语" } as Record<
        string,
        string
      >
    )[value] ??
    (value || "未指定")
  );
}

function conflictChoiceLabel(value: string) {
  return (
    (
      {
        source: "采用来源端",
        target: "保留目标端",
        manual: "手动合并",
        skip: "跳过这项",
      } as Record<string, string>
    )[value] ??
    (value || "未指定")
  );
}

function changeSetStatusLabel(status: ChangeSet["status"]) {
  return (
    {
      draft: "草稿",
      submitted: "等待审阅",
      partially_applied: "部分已应用",
      applied: "已应用",
      rejected: "已拒绝",
      stale: "基线已变化",
      failed: "应用失败",
    } as const
  )[status];
}

function changeItemStatusLabel(status: ChangeItem["status"]) {
  return (
    {
      proposed: "等待决定",
      approved: "已批准",
      rejected: "已拒绝",
      applied: "已应用",
      stale: "基线已变化",
      failed: "失败",
    } as const
  )[status];
}

function jobStatusLabel(status: string) {
  return (
    (
      {
        queued: "等待执行",
        running: "执行中",
        cancellation_requested: "正在取消",
        canceled: "已取消",
        succeeded: "已完成",
        failed: "失败",
      } as Record<string, string>
    )[status] ?? status
  );
}
