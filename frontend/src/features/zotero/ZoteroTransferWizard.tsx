import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { api } from "../../shared/api/client";
import type {
  Project,
  TransferConflict,
  TransferPreview,
  TransferReceipt,
} from "../../shared/api/contracts";
import { useApiResource } from "../../shared/api/useApiResource";
import { formatDateTime } from "../../shared/lib/format";
import { Icon } from "../../shared/ui/Icon";
import "./zotero.css";

type ConflictChoice = "source" | "target" | "skip";

export function ZoteroTransferWizard({ projects }: { projects: Project[] }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const persistedPreviewId = searchParams.get("transfer");
  const status = useApiResource(() => api.zoteroStatus(), []);
  const [direction, setDirection] = useState<"import" | "export">("import");
  const [kind, setKind] = useState<"users" | "groups">("users");
  const [libraryId, setLibraryId] = useState("0");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [receipt, setReceipt] = useState<TransferReceipt | null>(null);
  const [resolvedConflictIds, setResolvedConflictIds] = useState<Set<string>>(
    new Set(),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projectId, projects]);

  useEffect(() => {
    if (!persistedPreviewId) return;
    let disposed = false;
    setBusy("restore");
    setError(null);
    void api
      .zoteroTransfer(persistedPreviewId)
      .then((restored) => {
        if (!disposed) acceptPreview(restored);
      })
      .catch((reason) => {
        if (!disposed) setError(errorMessage(reason, "无法恢复上次迁移"));
      })
      .finally(() => {
        if (!disposed) setBusy(null);
      });
    return () => {
      disposed = true;
    };
  }, [persistedPreviewId]);

  useEffect(() => {
    if (!preview || preview.state !== "applying") return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void api
        .zoteroTransfer(preview.id)
        .then((current) => {
          if (!disposed) acceptPreview(current);
        })
        .catch(() => undefined);
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [preview?.id, preview?.state]);

  function acceptPreview(next: TransferPreview) {
    setPreview(next);
    setDirection(next.direction);
    setKind(next.library.kind);
    setLibraryId(next.library.id);
    setProjectId(next.project_id);
    setReceipt(next.receipt);
    setResolvedConflictIds(
      new Set(next.resolutions.map((resolution) => resolution.conflict_id)),
    );
    if (next.state !== "preview_ready" && next.state !== "recoverable")
      setConfirmed(false);
  }

  async function plan(event: FormEvent) {
    event.preventDefault();
    if (!libraryId.trim() || !projectId) return;
    setBusy("preview");
    setError(null);
    setReceipt(null);
    setConfirmed(false);
    setResolvedConflictIds(new Set());
    try {
      const next = await api.previewZoteroTransfer({
        direction,
        library: { kind, id: libraryId.trim() },
        project_id: projectId,
      });
      acceptPreview(next);
      setSearchParams(
        (current) => {
          const updated = new URLSearchParams(current);
          updated.set("transfer", next.id);
          return updated;
        },
        { replace: true },
      );
    } catch (reason) {
      setError(errorMessage(reason, "无法生成迁移预览"));
    } finally {
      setBusy(null);
    }
  }

  async function resolveConflict(
    conflict: TransferConflict,
    choice: ConflictChoice,
  ) {
    if (!preview) return;
    setBusy(`conflict:${conflict.id}`);
    setError(null);
    setConfirmed(false);
    try {
      await api.resolveZoteroConflict(preview.id, conflict.id, choice);
      acceptPreview(await api.zoteroTransfer(preview.id));
    } catch (reason) {
      setError(errorMessage(reason, "无法保存冲突决策"));
    } finally {
      setBusy(null);
    }
  }

  async function execute() {
    if (!preview || !confirmed) return;
    setBusy("execute");
    setError(null);
    try {
      const nextReceipt = await api.executeZoteroTransfer(
        preview.id,
        preview.preview_hash,
      );
      setReceipt(nextReceipt);
      acceptPreview(await api.zoteroTransfer(preview.id));
    } catch (reason) {
      setError(errorMessage(reason, "Zotero 迁移执行失败"));
    } finally {
      setBusy(null);
    }
  }

  async function analyzeConflicts() {
    if (!preview) return;
    setBusy("agent");
    setError(null);
    try {
      const launch = await api.createAgentRun({
        task_kind: "conflict_resolution",
        goal: "逐项分析这份 Zotero 迁移预览中的冲突，引用字段差异并提交冲突处理建议。",
        project_id: projectId,
        zotero_preview_id: preview.id,
      });
      navigate(
        `/agent-runs/${launch.run.id}?return_to=${encodeURIComponent(`/integrations?transfer=${preview.id}`)}`,
      );
    } catch (reason) {
      setError(errorMessage(reason, "无法启动冲突分析任务"));
      setBusy(null);
    }
  }

  const unresolvedConflicts =
    preview?.items
      .flatMap((item) => item.conflicts)
      .filter((conflict) => !resolvedConflictIds.has(conflict.id)) ?? [];
  const resolutions = new Map(
    preview?.resolutions.map((resolution) => [resolution.conflict_id, resolution.choice]) ?? [],
  );
  const hasBlockedItems = Boolean(preview?.summary.blocked);
  const unsafe = hasBlockedItems || unresolvedConflicts.length > 0;
  const isFinished = preview
    ? ["succeeded", "partial", "failed"].includes(preview.state)
    : false;
  const directionAvailable = status.data
    ? direction === "import"
      ? status.data.import_available
      : status.data.export_available
    : false;

  return (
    <div className="zotero-wizard">
      <form className="zotero-plan" onSubmit={(event) => void plan(event)}>
        <header>
          <span className="zotero-mark">Z</span>
          <div>
            <span className="eyebrow">ZOTERO TRANSFER</span>
            <h2>先预览，再迁移</h2>
            <p>差异由确定性代码生成；智能体不会直接写入文献库。</p>
          </div>
        </header>
        <EndpointStatus status={status.data} error={status.error} />
        <div className="transfer-direction">
          <button
            className={direction === "import" ? "active" : ""}
            disabled={status.data?.import_available === false}
            type="button"
            onClick={() => {
              setDirection("import");
              setPreview(null);
              setReceipt(null);
            }}
          >
            <Icon name="download" size={16} />
            <span>
              <strong>导入</strong>
              <small>Zotero → 当前项目</small>
            </span>
          </button>
          <button
            className={direction === "export" ? "active" : ""}
            disabled={status.data?.export_available === false}
            type="button"
            onClick={() => {
              setDirection("export");
              setPreview(null);
              setReceipt(null);
            }}
          >
            <Icon name="upload" size={16} />
            <span>
              <strong>导出</strong>
              <small>当前项目 → Zotero</small>
            </span>
          </button>
        </div>
        <div className="zotero-fields">
          <label>
            <span>库类型</span>
            <select
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as "users" | "groups")
              }
            >
              <option value="users">个人库</option>
              <option value="groups">群组库</option>
            </select>
          </label>
          <label>
            <span>库 ID</span>
            <input
              value={libraryId}
              onChange={(event) => setLibraryId(event.target.value)}
            />
          </label>
          <label>
            <span>项目</span>
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          className="primary-button preview-button"
          type="submit"
          disabled={
            busy !== null ||
            !projectId ||
            !libraryId.trim() ||
            !directionAvailable
          }
        >
          <Icon name="search" size={15} />
          {busy === "preview" ? "正在计算…" : "生成差异预览"}
        </button>
      </form>

      {preview ? (
        <section className="transfer-preview">
          <header>
            <div>
              <span className="eyebrow">迁移预览</span>
              <h2>迁移预览</h2>
              <p>
                {transferStatusLabel(preview.state)} · 有效期至{" "}
                {formatDateTime(preview.expires_at)}
              </p>
            </div>
            <div className="preview-header-actions">
              {unresolvedConflicts.length ? (
                <button
                  className="toolbar-button"
                  disabled={busy !== null}
                  type="button"
                  onClick={() => void analyzeConflicts()}
                >
                  <Icon name="sparkles" size={15} />
                  {busy === "agent" ? "正在启动…" : "请智能体分析"}
                </button>
              ) : null}
              <span className={`transfer-state transfer-state--${preview.state}`}>
                {transferStatusLabel(preview.state)}
              </span>
            </div>
          </header>
          <div className="transfer-summary">
            {(
              ["new", "update", "unchanged", "conflict", "blocked"] as const
            ).map((action) => (
              <div
                className={`transfer-count transfer-count--${action}`}
                key={action}
              >
                <span>{actionLabel(action)}</span>
                <strong>{preview.summary[action] ?? 0}</strong>
              </div>
            ))}
          </div>
          <div className="transfer-table">
            <div className="transfer-table-head">
              <span>条目</span>
              <span>动作</span>
              <span>差异</span>
            </div>
            {preview.items.map((item) => (
              <article key={item.item_id}>
                <span title={item.display_title}>{item.display_title}</span>
                <strong
                  className={`transfer-action transfer-action--${item.action}`}
                >
                  {actionLabel(item.action)}
                </strong>
                <span>
                  {item.blocked_reason ||
                    item.conflicts[0]?.message ||
                    `${item.differences.length} 个字段变化`}
                </span>
                {item.conflicts.map((conflict) => (
                  <ConflictControls
                    busy={busy === `conflict:${conflict.id}`}
                    conflict={conflict}
                    direction={preview.direction}
                    key={conflict.id}
                    resolvedChoice={resolutions.get(conflict.id) ?? null}
                    onResolve={resolveConflict}
                  />
                ))}
                {item.differences.length ? (
                  <details>
                    <summary>查看字段差异</summary>
                    <div>
                      {item.differences.map((difference) => (
                        <p key={difference.field}>
                          <strong>{difference.field}</strong>
                          <del>{shortJson(difference.target)}</del>
                          <ins>{shortJson(difference.source)}</ins>
                        </p>
                      ))}
                    </div>
                  </details>
                ) : null}
              </article>
            ))}
          </div>
          {hasBlockedItems ? (
            <div className="transfer-warning">
              <Icon name="shield" size={16} />
              <p>
                预览中有后端判定为不可执行的条目。请修正范围后重新生成预览。
              </p>
            </div>
          ) : preview.state === "applying" ? (
            <div className="transfer-progress" role="status">
              <Icon name="activity" size={16} />
              <p>迁移正在执行。每个条目的进度都会立即保存，这个页面可以安全刷新。</p>
            </div>
          ) : preview.state === "recoverable" ? (
            <label className="transfer-confirm transfer-confirm--recoverable">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>上次执行已中断；确认后将从已保存的条目继续，不会重复导入。</span>
            </label>
          ) : unresolvedConflicts.length ? (
            <div className="transfer-warning">
              <Icon name="shield" size={16} />
              <p>
                还有 {unresolvedConflicts.length}{" "}
                个冲突未决。请为每个冲突选择来源、目标或跳过。
              </p>
            </div>
          ) : isFinished ? (
            <div className={`transfer-finished transfer-finished--${preview.state}`}>
              <Icon name={preview.state === "succeeded" ? "check" : "activity"} size={16} />
              <p>{transferStatusDescription(preview.state)}</p>
            </div>
          ) : (
            <label className="transfer-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                我已核对条目与冲突决策。执行前系统会再次校验版本，内容变化时会自动停止。
              </span>
            </label>
          )}
          {!isFinished && preview.state !== "applying" ? (
            <button
              className="primary-button execute-transfer"
              type="button"
              disabled={!confirmed || busy !== null || unsafe}
              onClick={() => void execute()}
            >
              <Icon name={preview.state === "recoverable" ? "refresh" : "check"} size={15} />
              {busy === "execute"
                ? "正在执行…"
                : preview.state === "recoverable"
                  ? "从断点继续迁移"
                  : "确认并执行迁移"}
            </button>
          ) : null}
        </section>
      ) : (
        <section className="transfer-placeholder">
          <Icon name="plug" size={27} />
          <h2>尚未生成预览</h2>
          <p>填写左侧范围后，系统只读取并计算差异，不会立即写入。</p>
        </section>
      )}

      {receipt ? (
        <div className={`transfer-receipt transfer-receipt--${preview?.state ?? receipt.status}`}>
          <Icon name={receipt.status === "succeeded" ? "check" : "activity"} size={17} />
          <div>
            <strong>
              {preview?.state === "recoverable"
                ? "进度已保存，可以继续"
                : receipt.status === "succeeded"
                  ? "迁移完成"
                  : receipt.status === "applying"
                    ? "迁移正在执行"
                    : "迁移已结束"}
            </strong>
            <p>
              {receipt.items.length} 个条目
              {receipt.finished_at
                ? ` · ${formatDateTime(receipt.finished_at)}`
                : " · 已持久化进度"}
            </p>
            {receipt.items.some((item) => item.outcome === "failed") ? (
              <ul>
                {receipt.items
                  .filter((item) => item.outcome === "failed")
                  .map((item) => (
                    <li key={item.item_id}>{item.message || "该条目迁移失败"}</li>
                  ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
      {error ? <div className="transfer-error">{error}</div> : null}
    </div>
  );
}

function EndpointStatus({
  status,
  error,
}: {
  status: Awaited<ReturnType<typeof api.zoteroStatus>> | null;
  error: string | null;
}) {
  if (error)
    return <p className="zotero-status zotero-status--error">{error}</p>;
  if (!status) return <p className="zotero-status">正在检查 Zotero 连接…</p>;
  return (
    <div className="zotero-status-grid">
      <span
        className={status.local.available ? "ready" : "unavailable"}
        title={
          status.local.available
            ? "已连接 Zotero Desktop 本机接口"
            : "请启动 Zotero Desktop，并确认本机接口可访问"
        }
      >
        本机接口 · {status.local.available ? "可读" : "不可用"}
      </span>
      <span
        className={status.web.available ? "ready" : "unavailable"}
        title={
          status.web.available
            ? "Zotero Web API 已配置，可用于导入与导出"
            : "尚未配置 Zotero Web API 密钥，暂时无法导出"
        }
      >
        Web API · {status.web.available ? "可读写" : "未配置"}
      </span>
    </div>
  );
}

function ConflictControls({
  conflict,
  direction,
  resolvedChoice,
  busy,
  onResolve,
}: {
  conflict: TransferConflict;
  direction: "import" | "export";
  resolvedChoice: "source" | "target" | "manual" | "skip" | null;
  busy: boolean;
  onResolve: (
    conflict: TransferConflict,
    choice: ConflictChoice,
  ) => Promise<void>;
}) {
  if (resolvedChoice)
    return (
      <div className="conflict-resolution conflict-resolution--resolved">
        <Icon name="check" size={13} />
        {conflictChoiceLabel(resolvedChoice, direction)}
      </div>
    );
  return (
    <div className="conflict-resolution">
      <p>{conflict.message}</p>
      <div>
        <button
          disabled={busy}
          type="button"
          onClick={() => void onResolve(conflict, "source")}
        >
          {direction === "import" ? "使用 Zotero" : "使用当前项目"}
        </button>
        <button
          disabled={busy}
          type="button"
          onClick={() => void onResolve(conflict, "target")}
        >
          {direction === "import" ? "保留当前项目" : "保留 Zotero"}
        </button>
        <button
          disabled={busy}
          type="button"
          onClick={() => void onResolve(conflict, "skip")}
        >
          跳过此条
        </button>
      </div>
    </div>
  );
}

function actionLabel(
  action: "new" | "update" | "unchanged" | "conflict" | "blocked",
) {
  return (
    {
      new: "新建",
      update: "更新",
      unchanged: "不变",
      conflict: "冲突",
      blocked: "阻塞",
    } as const
  )[action];
}

function conflictChoiceLabel(
  choice: "source" | "target" | "manual" | "skip",
  direction: "import" | "export",
) {
  if (choice === "skip") return "已决定跳过此条";
  if (choice === "manual") return "已保存人工合并方案";
  if (choice === "source") {
    return direction === "import" ? "已选择 Zotero 版本" : "已选择当前项目版本";
  }
  return direction === "import" ? "已保留当前项目版本" : "已保留 Zotero 版本";
}

function transferStatusLabel(status: TransferPreview["state"]) {
  return {
    preview_ready: "等待确认",
    applying: "正在执行",
    recoverable: "可从断点继续",
    succeeded: "迁移完成",
    partial: "部分完成",
    failed: "迁移失败",
  }[status];
}

function transferStatusDescription(status: TransferPreview["state"]) {
  return {
    preview_ready: "预览已准备好。",
    applying: "迁移正在执行。",
    recoverable: "迁移可以从已保存的断点继续。",
    succeeded: "所有计划条目均已完成。",
    partial: "部分条目未能完成，请查看下方失败原因后重新生成预览。",
    failed: "迁移没有完成，请查看下方原因并重试。",
  }[status];
}

function shortJson(value: unknown) {
  const text = JSON.stringify(value) ?? "—";
  return text.length > 100 ? `${text.slice(0, 97)}…` : text;
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}
