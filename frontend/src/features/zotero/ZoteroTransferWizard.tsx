import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

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
  const status = useApiResource(() => api.zoteroStatus(), []);
  const [direction, setDirection] = useState<"import" | "export">("import");
  const [kind, setKind] = useState<"users" | "groups">("users");
  const [libraryId, setLibraryId] = useState("0");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [receipt, setReceipt] = useState<TransferReceipt | null>(null);
  const [resolvedConflictIds, setResolvedConflictIds] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projectId, projects]);

  async function plan(event: FormEvent) {
    event.preventDefault();
    if (!libraryId.trim() || !projectId) return;
    setBusy("preview");
    setError(null);
    setReceipt(null);
    setConfirmed(false);
    setResolvedConflictIds(new Set());
    try {
      setPreview(await api.previewZoteroTransfer({
        direction,
        library: { kind, id: libraryId.trim() },
        project_id: projectId,
      }));
    } catch (reason) {
      setError(errorMessage(reason, "无法生成迁移预览"));
    } finally {
      setBusy(null);
    }
  }

  async function resolveConflict(conflict: TransferConflict, choice: ConflictChoice) {
    if (!preview) return;
    setBusy(`conflict:${conflict.id}`);
    setError(null);
    setConfirmed(false);
    try {
      await api.resolveZoteroConflict(preview.id, conflict.id, choice);
      setResolvedConflictIds((current) => new Set(current).add(conflict.id));
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
      setReceipt(await api.executeZoteroTransfer(preview.id, preview.preview_hash));
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
      navigate(`/agent-runs/${launch.run.id}`);
    } catch (reason) {
      setError(errorMessage(reason, "无法启动冲突分析任务"));
      setBusy(null);
    }
  }

  const unresolvedConflicts = preview?.items.flatMap((item) => item.conflicts)
    .filter((conflict) => !resolvedConflictIds.has(conflict.id)) ?? [];
  const hasBlockedItems = Boolean(preview?.summary.blocked);
  const unsafe = hasBlockedItems || unresolvedConflicts.length > 0;
  const directionAvailable = status.data
    ? direction === "import" ? status.data.import_available : status.data.export_available
    : false;

  return (
    <div className="zotero-wizard">
      <form className="zotero-plan" onSubmit={(event) => void plan(event)}>
        <header>
          <span className="zotero-mark">Z</span>
          <div><span className="eyebrow">ZOTERO TRANSFER</span><h2>先预览，再迁移</h2><p>差异由确定性代码生成；智能体不会直接写入文献库。</p></div>
        </header>
        <EndpointStatus status={status.data} error={status.error} />
        <div className="transfer-direction">
          <button className={direction === "import" ? "active" : ""} disabled={status.data?.import_available === false} type="button" onClick={() => { setDirection("import"); setPreview(null); setReceipt(null); }}><Icon name="download" size={16} /><span><strong>导入</strong><small>Zotero → 当前项目</small></span></button>
          <button className={direction === "export" ? "active" : ""} disabled={status.data?.export_available === false} type="button" onClick={() => { setDirection("export"); setPreview(null); setReceipt(null); }}><Icon name="upload" size={16} /><span><strong>导出</strong><small>当前项目 → Zotero</small></span></button>
        </div>
        <div className="zotero-fields">
          <label><span>库类型</span><select value={kind} onChange={(event) => setKind(event.target.value as "users" | "groups")}><option value="users">个人库</option><option value="groups">群组库</option></select></label>
          <label><span>库 ID</span><input value={libraryId} onChange={(event) => setLibraryId(event.target.value)} /></label>
          <label><span>项目</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        </div>
        <button className="primary-button preview-button" type="submit" disabled={busy !== null || !projectId || !libraryId.trim() || !directionAvailable}><Icon name="search" size={15} />{busy === "preview" ? "正在计算…" : "生成差异预览"}</button>
      </form>

      {preview ? (
        <section className="transfer-preview">
          <header><div><span className="eyebrow">PREVIEW</span><h2>迁移预览</h2><p>有效期至 {formatDateTime(preview.expires_at)}</p></div><div className="preview-header-actions">{unresolvedConflicts.length ? <button className="toolbar-button" disabled={busy !== null} type="button" onClick={() => void analyzeConflicts()}><Icon name="sparkles" size={15} />{busy === "agent" ? "正在启动…" : "请智能体分析"}</button> : null}<code title={preview.preview_hash}>{preview.preview_hash.slice(0, 12)}</code></div></header>
          <div className="transfer-summary">{(["new", "update", "unchanged", "conflict", "blocked"] as const).map((action) => <div className={`transfer-count transfer-count--${action}`} key={action}><span>{actionLabel(action)}</span><strong>{preview.summary[action] ?? 0}</strong></div>)}</div>
          <div className="transfer-table">
            <div className="transfer-table-head"><span>条目</span><span>动作</span><span>差异</span></div>
            {preview.items.map((item) => (
              <article key={item.item_id}>
                <span title={item.item_id}>{item.item_id}</span>
                <strong className={`transfer-action transfer-action--${item.action}`}>{actionLabel(item.action)}</strong>
                <span>{item.blocked_reason || item.conflicts[0]?.message || `${item.differences.length} 个字段变化`}</span>
                {item.conflicts.map((conflict) => (
                  <ConflictControls
                    busy={busy === `conflict:${conflict.id}`}
                    conflict={conflict}
                    direction={preview.direction}
                    key={conflict.id}
                    resolved={resolvedConflictIds.has(conflict.id)}
                    onResolve={resolveConflict}
                  />
                ))}
                {item.differences.length ? <details><summary>查看字段差异</summary><div>{item.differences.map((difference) => <p key={difference.field}><strong>{difference.field}</strong><del>{shortJson(difference.target)}</del><ins>{shortJson(difference.source)}</ins></p>)}</div></details> : null}
              </article>
            ))}
          </div>
          {hasBlockedItems ? <div className="transfer-warning"><Icon name="shield" size={16} /><p>预览中有后端判定为不可执行的条目。请修正范围后重新生成预览。</p></div> : unresolvedConflicts.length ? <div className="transfer-warning"><Icon name="shield" size={16} /><p>还有 {unresolvedConflicts.length} 个冲突未决。请为每个冲突选择来源、目标或跳过。</p></div> : <label className="transfer-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我确认执行这份哈希固定的预览；执行时若版本变化，后端必须拒绝。</span></label>}
          <button className="primary-button execute-transfer" type="button" disabled={!confirmed || busy !== null || unsafe} onClick={() => void execute()}><Icon name="check" size={15} />{busy === "execute" ? "正在执行…" : "确认并执行迁移"}</button>
        </section>
      ) : (
        <section className="transfer-placeholder"><Icon name="plug" size={27} /><h2>尚未生成预览</h2><p>填写左侧范围后，系统只读取并计算差异，不会立即写入。</p></section>
      )}

      {receipt ? <div className={`transfer-receipt transfer-receipt--${receipt.status}`}><Icon name="check" size={17} /><div><strong>迁移{receipt.status === "succeeded" ? "完成" : "已结束"}</strong><p>{receipt.items.length} 个条目 · {formatDateTime(receipt.finished_at)}</p></div></div> : null}
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
  if (error) return <p className="zotero-status zotero-status--error">{error}</p>;
  if (!status) return <p className="zotero-status">正在检查 Zotero 连接…</p>;
  return (
    <div className="zotero-status-grid">
      <span className={status.local.available ? "ready" : "unavailable"} title={status.local.message}>本机接口 · {status.local.available ? "可读" : "不可用"}</span>
      <span className={status.web.available ? "ready" : "unavailable"} title={status.web.message}>Web API · {status.web.available ? "可读写" : "未配置"}</span>
    </div>
  );
}

function ConflictControls({
  conflict,
  direction,
  resolved,
  busy,
  onResolve,
}: {
  conflict: TransferConflict;
  direction: "import" | "export";
  resolved: boolean;
  busy: boolean;
  onResolve: (conflict: TransferConflict, choice: ConflictChoice) => Promise<void>;
}) {
  if (resolved) return <div className="conflict-resolution conflict-resolution--resolved"><Icon name="check" size={13} />冲突决策已保存</div>;
  return (
    <div className="conflict-resolution">
      <p>{conflict.message}</p>
      <div>
        <button disabled={busy} type="button" onClick={() => void onResolve(conflict, "source")}>{direction === "import" ? "使用 Zotero" : "使用当前项目"}</button>
        <button disabled={busy} type="button" onClick={() => void onResolve(conflict, "target")}>{direction === "import" ? "保留当前项目" : "保留 Zotero"}</button>
        <button disabled={busy} type="button" onClick={() => void onResolve(conflict, "skip")}>跳过此条</button>
      </div>
    </div>
  );
}

function actionLabel(action: "new" | "update" | "unchanged" | "conflict" | "blocked") {
  return ({ new: "新建", update: "更新", unchanged: "不变", conflict: "冲突", blocked: "阻塞" } as const)[action];
}

function shortJson(value: unknown) {
  const text = JSON.stringify(value) ?? "—";
  return text.length > 100 ? `${text.slice(0, 97)}…` : text;
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}
