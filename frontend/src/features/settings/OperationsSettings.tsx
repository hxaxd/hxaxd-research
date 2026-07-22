import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../../shared/api/client";
import type {
  AuditEvent,
  Job,
  ManagedTool,
  ManagedToolName,
  SnapshotItem,
} from "../../shared/api/contracts";
import { useApiResource } from "../../shared/api/useApiResource";
import { formatBytes, formatDateTime } from "../../shared/lib/format";
import { Icon } from "../../shared/ui/Icon";
import "./settings.css";

export function OperationsSettings() {
  const resource = useApiResource(
    () => Promise.all([api.tools(), api.snapshots(), api.auditEvents()]),
    [],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmations, setConfirmations] = useState<Record<string, string>>(
    {},
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trackedJob, setTrackedJob] = useState<Job | null>(null);
  const trackedJobId = trackedJob?.id ?? null;
  const jobActive = trackedJob
    ? ["queued", "running", "cancellation_requested"].includes(
        trackedJob.status,
      )
    : false;

  useEffect(() => {
    if (!trackedJobId || !jobActive) return;
    const jobId = trackedJobId;
    let stopped = false;
    async function poll() {
      try {
        const next = await api.job(jobId);
        if (stopped) return;
        setTrackedJob(next);
        if (next.status === "succeeded") {
          setMessage("任务已完成，状态已刷新。");
          await resource.reload();
        } else if (next.status === "failed" || next.status === "canceled") {
          setMessage(null);
          setError(
            next.error_message ||
              (next.status === "canceled" ? "任务已取消" : "任务执行失败"),
          );
        }
      } catch (reason) {
        if (!stopped) setError(errorMessage(reason, "无法更新任务状态"));
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [jobActive, resource.reload, trackedJobId]);

  async function install(name: ManagedToolName) {
    setBusy(`tool:${name}`);
    setMessage(null);
    setError(null);
    try {
      const job = await api.installTool(name);
      setTrackedJob(job);
      setMessage("工具任务已提交，完成后会自动刷新状态。");
    } catch (reason) {
      setError(errorMessage(reason, "无法创建工具安装任务"));
    } finally {
      setBusy(null);
    }
  }

  async function createSnapshot() {
    setBusy("snapshot:create");
    setMessage(null);
    setError(null);
    try {
      const job = await api.createSnapshot();
      setTrackedJob(job);
      setMessage("快照任务已提交，完成后会出现在下方列表。");
    } catch (reason) {
      setError(errorMessage(reason, "无法创建工作区快照"));
    } finally {
      setBusy(null);
    }
  }

  async function restore(snapshot: SnapshotItem) {
    const confirmation = confirmations[snapshot.filename] ?? "";
    if (confirmation !== snapshot.filename) return;
    setBusy(`snapshot:${snapshot.filename}`);
    setMessage(null);
    setError(null);
    try {
      const job = await api.restoreSnapshot(snapshot.filename, confirmation);
      setTrackedJob(job);
      setMessage("恢复任务已提交；执行期间请不要关闭后端服务。");
      setConfirmations((current) => ({ ...current, [snapshot.filename]: "" }));
    } catch (reason) {
      setError(errorMessage(reason, "无法创建快照恢复任务"));
    } finally {
      setBusy(null);
    }
  }

  const tools = resource.data?.[0] ?? [];
  const snapshots = resource.data?.[1].snapshots ?? [];
  const auditEvents = resource.data?.[2].items ?? [];

  return (
    <div className="operations-settings">
      <section className="settings-operation-section">
        <header>
          <div>
            <span className="eyebrow">自动安装与验证</span>
            <h2>受管工具</h2>
            <p>安装和校验都由后端任务执行，前端不会直接运行脚本。</p>
          </div>
          <button
            className="toolbar-button"
            type="button"
            onClick={() => void resource.reload()}
          >
            <Icon name="refresh" size={14} />
            刷新状态
          </button>
        </header>
        <div className="managed-tool-grid">
          {tools.map((tool) => (
            <ToolCard
              busy={busy === `tool:${tool.name}` || jobActive}
              key={tool.name}
              tool={tool}
              onInstall={install}
            />
          ))}
          {!resource.loading && !tools.length ? (
            <p className="settings-empty">后端没有报告可管理的工具。</p>
          ) : null}
        </div>
      </section>

      <section className="settings-operation-section audit-settings">
        <header>
          <div>
            <span className="eyebrow">可追溯操作</span>
            <h2>最近活动</h2>
            <p>
              这里只显示经过公开投影清理的领域事件；任务的逐步日志仍在任务中心。
            </p>
          </div>
        </header>
        {auditEvents.length ? (
          <ol className="audit-event-list">
            {auditEvents.map((event) => (
              <li key={event.id}>
                <Icon name="activity" size={15} />
                <span>
                  <strong>{auditEventLabel(event)}</strong>
                  <small>
                    {auditEntityLabel(event.entity_type)} ·{" "}
                    {formatDateTime(event.occurred_at)}
                  </small>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="settings-empty">还没有可显示的领域活动。</p>
        )}
      </section>

      <section className="settings-operation-section snapshot-settings">
        <header>
          <div>
            <span className="eyebrow">备份与恢复</span>
            <h2>工作区快照</h2>
            <p>
              快照包含数据库与附件；恢复会替换当前状态，且要求工作区没有运行中的任务。
            </p>
          </div>
          <button
            className="primary-button"
            disabled={busy !== null || jobActive}
            type="button"
            onClick={() => void createSnapshot()}
          >
            <Icon name="plus" size={14} />
            {busy === "snapshot:create" ? "正在提交…" : "创建快照"}
          </button>
        </header>
        <div className="snapshot-list">
          {snapshots.map((snapshot) => {
            const confirmation = confirmations[snapshot.filename] ?? "";
            const confirmed = confirmation === snapshot.filename;
            return (
              <article className="snapshot-row" key={snapshot.filename}>
                <div className="snapshot-summary">
                  <Icon name="shield" size={17} />
                  <span>
                    <strong>{snapshot.filename}</strong>
                    <small>
                      {formatDateTime(snapshot.created_at)} ·{" "}
                      {formatBytes(snapshot.size)}
                    </small>
                  </span>
                  <a className="toolbar-button" href={snapshot.download_url}>
                    <Icon name="download" size={14} />
                    下载
                  </a>
                </div>
                <div className="snapshot-restore">
                  <label htmlFor={`snapshot-${snapshot.filename}`}>
                    输入完整文件名以确认恢复
                  </label>
                  <div>
                    <input
                      autoComplete="off"
                      id={`snapshot-${snapshot.filename}`}
                      placeholder={snapshot.filename}
                      value={confirmation}
                      onChange={(event) =>
                        setConfirmations((current) => ({
                          ...current,
                          [snapshot.filename]: event.target.value,
                        }))
                      }
                    />
                    <button
                      className="snapshot-restore-button"
                      disabled={!confirmed || busy !== null || jobActive}
                      type="button"
                      onClick={() => void restore(snapshot)}
                    >
                      {busy === `snapshot:${snapshot.filename}`
                        ? "正在提交…"
                        : "恢复此快照"}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
          {!resource.loading && !snapshots.length ? (
            <p className="settings-empty">还没有可下载的工作区快照。</p>
          ) : null}
        </div>
      </section>

      {resource.loading ? (
        <p className="settings-feedback">正在读取工具和快照状态…</p>
      ) : null}
      {resource.error || error ? (
        <div className="settings-feedback settings-feedback--error">
          {resource.error || error}
          {resource.error ? (
            <button
              className="toolbar-button"
              type="button"
              onClick={() => void resource.retry()}
            >
              <Icon name="refresh" size={13} />
              重新读取
            </button>
          ) : null}
        </div>
      ) : null}
      {message ? (
        <p className="settings-feedback settings-feedback--success">
          <Icon name={jobActive ? "activity" : "check"} size={13} />
          {message}
          {trackedJob ? (
            <Link to={`/tasks?job=${trackedJob.id}`}>
              {jobActive ? "查看实时进度" : "查看执行记录"}
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function ToolCard({
  tool,
  busy,
  onInstall,
}: {
  tool: ManagedTool;
  busy: boolean;
  onInstall: (name: ManagedToolName) => Promise<void>;
}) {
  return (
    <article className="managed-tool-card">
      <header>
        <Icon name="terminal" size={18} />
        <div>
          <h3>{tool.label}</h3>
          <p>{tool.description}</p>
        </div>
        <span className={`tool-status tool-status--${tool.status}`}>
          {toolStatusLabel(tool.status)}
        </span>
      </header>
      <dl>
        <dt>版本</dt>
        <dd>{tool.version || "—"}</dd>
        <dt>状态</dt>
        <dd>{tool.message}</dd>
      </dl>
      <button
        className="toolbar-button"
        disabled={busy || tool.status === "installing"}
        type="button"
        onClick={() => void onInstall(tool.name)}
      >
        <Icon name={tool.status === "ready" ? "check" : "download"} size={14} />
        {busy
          ? "正在提交…"
          : tool.status === "ready"
            ? "验证工具"
            : tool.status === "upgrade_required"
              ? "升级工具"
              : tool.status === "failed"
                ? "重试安装"
                : "安装工具"}
      </button>
    </article>
  );
}

function toolStatusLabel(status: ManagedTool["status"]) {
  return (
    {
      missing: "未安装",
      upgrade_required: "需要升级",
      installing: "安装中",
      ready: "可用",
      failed: "失败",
    } as const
  )[status];
}

function auditEventLabel(event: AuditEvent) {
  const labels: Record<string, string> = {
    "legacy.imported": "导入旧工作区",
    "catalog.work_created": "文献入库",
    "catalog.metadata_patched": "更新文献元数据",
    "catalog.item_version_appended": "保存文献新版本",
    "screening.project_created": "创建筛选项目",
    "screening.project_deleted": "删除筛选项目",
    "screening.candidate_staged": "暂存候选文献",
    "screening.candidate_promoted": "候选文献转为正式文献",
    "screening.candidate_included": "纳入候选文献",
    "screening.candidate_excluded": "排除候选文献",
    "screening.candidate_archived": "归档候选文献",
    "screening.candidate_dismissed": "移除候选文献",
    "screening.decision_changed": "修改筛选决定",
    "screening.project_insights_applied": "应用项目分析结果",
    "document.extracted": "完成论文结构识别",
    "document.translated": "完成论文翻译",
    "document.translation_batch_verified": "确认整篇翻译",
    "changes.submitted": "提交变更建议",
    "changes.reviewed": "审核变更建议",
    "changes.unselected_rejected": "拒绝未选变更",
    "changes.apply_finished": "完成变更应用",
    "annotation.created": "添加批注",
    "annotation.updated": "更新批注",
    "annotation.deleted": "删除批注",
    "reading_state.updated": "更新阅读进度",
    "reading_bookmark.created": "添加阅读书签",
    "reading_bookmark.deleted": "删除阅读书签",
    "device_pairing.created": "创建设备配对",
    "device_session.created": "设备接入工作台",
    "device_session.revoked": "撤销设备访问",
    "user_preferences.updated": "更新工作台设置",
    "workspace.snapshot_created": "创建工作区快照",
    "workspace.restored": "恢复工作区快照",
    "snapshot.control_job_omitted": "整理快照任务记录",
  };
  return labels[event.action] ?? "其他工作台活动";
}

function auditEntityLabel(entityType: string) {
  return (
    (
      {
        candidate: "候选",
        project: "筛选项目",
        work: "文献",
        item: "文献",
        document: "结构化论文",
        change_set: "变更建议",
        workspace: "工作区",
        annotation: "批注",
        reading_state: "阅读进度",
        reading_bookmark: "阅读书签",
        user_preferences: "工作台设置",
        device_pairing: "设备配对",
        device_session: "设备访问",
      } as Record<string, string>
    )[entityType] ?? "系统记录"
  );
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}
