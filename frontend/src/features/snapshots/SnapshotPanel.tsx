import { api } from "../../shared/api/client";
import { formatBytes } from "../../shared/lib/format";
import { Icon } from "../../shared/ui/Icon";
import { useSnapshots } from "./useSnapshots";
import "./snapshots.css";

export function SnapshotPanel() {
  const { overview, loading, error, create, restore } = useSnapshots();
  const running = overview?.operation?.status === "running";
  const restored = overview?.operation?.kind === "restore"
    && overview.operation.status === "succeeded";

  return (
    <section className="snapshot-panel" aria-labelledby="snapshot-panel-title">
      <header className="snapshot-panel-heading">
        <div>
          <span className="eyebrow">DATA LIFECYCLE</span>
          <h2 id="snapshot-panel-title">数据备份</h2>
        </div>
        <button className="snapshot-create" type="button" disabled={running} onClick={() => void create()}>
          <Icon name="download" size={15} />
          {running && overview?.operation?.kind === "backup" ? "正在备份" : "创建完整备份"}
        </button>
      </header>

      {error ? <div className="snapshot-error">{error}</div> : null}
      {overview?.operation ? (
        <div className={`snapshot-operation snapshot-operation--${overview.operation.status}`}>
          <span><i />{overview.operation.message}</span>
          {overview.operation.error ? <p>{overview.operation.error}</p> : null}
          {restored ? (
            <button type="button" onClick={() => window.location.reload()}>刷新工作台</button>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <div className="snapshot-empty">正在读取备份…</div>
      ) : overview && overview.snapshots.length > 0 ? (
        <div className="snapshot-list">
          {overview.snapshots.slice(0, 4).map((snapshot) => (
            <article className="snapshot-item" key={snapshot.filename}>
              <div className="snapshot-item-icon"><Icon name="library" size={18} /></div>
              <div className="snapshot-item-copy">
                <strong>{snapshot.filename}</strong>
                <span>{formatTime(snapshot.created_at)} · {formatBytes(snapshot.size)}</span>
              </div>
              <div className="snapshot-actions">
                <a href={api.snapshotDownloadUrl(snapshot.filename)} download>
                  <Icon name="download" size={14} />下载
                </a>
                <button type="button" disabled={running} onClick={() => void restore(snapshot.filename)}>
                  <Icon name="upload" size={14} />恢复
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="snapshot-empty">还没有备份。创建后可以直接下载，或在需要时恢复。</div>
      )}
    </section>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
