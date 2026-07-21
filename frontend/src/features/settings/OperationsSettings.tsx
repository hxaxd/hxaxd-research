import { useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../../shared/api/client";
import type { ManagedTool, ManagedToolName, SnapshotItem } from "../../shared/api/contracts";
import { useApiResource } from "../../shared/api/useApiResource";
import { formatBytes, formatDateTime } from "../../shared/lib/format";
import { Icon } from "../../shared/ui/Icon";
import "./settings.css";

export function OperationsSettings() {
  const resource = useApiResource(
    () => Promise.all([api.tools(), api.snapshots()]),
    [],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmations, setConfirmations] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function install(name: ManagedToolName) {
    setBusy(`tool:${name}`);
    setMessage(null);
    setError(null);
    try {
      const job = await api.installTool(name);
      setMessage(`工具任务已创建：${job.id}`);
      await resource.reload();
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
      setMessage(`快照创建任务已提交：${job.id}`);
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
      setMessage(`快照恢复任务已提交：${job.id}`);
      setConfirmations((current) => ({ ...current, [snapshot.filename]: "" }));
    } catch (reason) {
      setError(errorMessage(reason, "无法创建快照恢复任务"));
    } finally {
      setBusy(null);
    }
  }

  const tools = resource.data?.[0] ?? [];
  const snapshots = resource.data?.[1].snapshots ?? [];

  return (
    <div className="operations-settings">
      <section className="settings-operation-section">
        <header>
          <div>
            <span className="eyebrow">MANAGED TOOLS</span>
            <h2>受管工具</h2>
            <p>安装和校验都由后端任务执行，前端不会直接运行脚本。</p>
          </div>
          <button className="toolbar-button" type="button" onClick={() => void resource.reload()}>
            <Icon name="refresh" size={14} />刷新状态
          </button>
        </header>
        <div className="managed-tool-grid">
          {tools.map((tool) => (
            <ToolCard
              busy={busy === `tool:${tool.name}`}
              key={tool.name}
              tool={tool}
              onInstall={install}
            />
          ))}
          {!resource.loading && !tools.length ? <p className="settings-empty">后端没有报告可管理的工具。</p> : null}
        </div>
      </section>

      <section className="settings-operation-section snapshot-settings">
        <header>
          <div>
            <span className="eyebrow">WORKSPACE SNAPSHOTS</span>
            <h2>工作区快照</h2>
            <p>快照包含数据库与附件；恢复会替换当前状态，且要求工作区没有运行中的任务。</p>
          </div>
          <button className="primary-button" disabled={busy !== null} type="button" onClick={() => void createSnapshot()}>
            <Icon name="plus" size={14} />{busy === "snapshot:create" ? "正在提交…" : "创建快照"}
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
                    <small>{formatDateTime(snapshot.created_at)} · {formatBytes(snapshot.size)}</small>
                  </span>
                  <a className="toolbar-button" href={snapshot.download_url}>
                    <Icon name="download" size={14} />下载
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
                      onChange={(event) => setConfirmations((current) => ({
                        ...current,
                        [snapshot.filename]: event.target.value,
                      }))}
                    />
                    <button
                      className="snapshot-restore-button"
                      disabled={!confirmed || busy !== null}
                      type="button"
                      onClick={() => void restore(snapshot)}
                    >
                      {busy === `snapshot:${snapshot.filename}` ? "正在提交…" : "恢复此快照"}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
          {!resource.loading && !snapshots.length ? <p className="settings-empty">还没有可下载的工作区快照。</p> : null}
        </div>
      </section>

      {resource.loading ? <p className="settings-feedback">正在读取工具和快照状态…</p> : null}
      {resource.error || error ? <p className="settings-feedback settings-feedback--error">{resource.error || error}</p> : null}
      {message ? <p className="settings-feedback settings-feedback--success"><Icon name="check" size={13} />{message}<Link to="/tasks">打开任务中心</Link></p> : null}
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
        <div><h3>{tool.label}</h3><p>{tool.description}</p></div>
        <span className={`tool-status tool-status--${tool.status}`}>{toolStatusLabel(tool.status)}</span>
      </header>
      <dl>
        <dt>版本</dt><dd>{tool.version || "—"}</dd>
        <dt>状态</dt><dd>{tool.message}</dd>
      </dl>
      <button
        className="toolbar-button"
        disabled={busy || tool.status === "installing"}
        type="button"
        onClick={() => void onInstall(tool.name)}
      >
        <Icon name={tool.status === "ready" ? "check" : "download"} size={14} />
        {busy ? "正在提交…" : tool.status === "ready" ? "验证工具" : tool.status === "failed" ? "重试安装" : "安装工具"}
      </button>
    </article>
  );
}

function toolStatusLabel(status: ManagedTool["status"]) {
  return ({ missing: "未安装", installing: "安装中", ready: "可用", failed: "失败" } as const)[status];
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}
