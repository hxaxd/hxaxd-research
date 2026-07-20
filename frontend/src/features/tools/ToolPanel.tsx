import type { ManagedTool, ToolName } from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";
import { useTools } from "./useTools";
import "./tools.css";

const statusLabels = {
  missing: "需要安装",
  installing: "正在安装",
  installed: "已经就绪",
  failed: "安装失败",
} as const;

export function ToolPanel() {
  const { tools, loading, error, install } = useTools();

  return (
    <section className="tool-panel" aria-labelledby="tool-panel-title">
      <header className="tool-panel-heading">
        <div>
          <span className="eyebrow">LOCAL ENVIRONMENT</span>
          <h2 id="tool-panel-title">本地工具</h2>
        </div>
        <p>统一安装到仓库的 <code>.tools</code> 目录，翻译和编译只使用这里的版本。</p>
      </header>

      {error ? <div className="tool-panel-error">{error}</div> : null}
      {loading ? (
        <div className="tool-panel-loading">正在检查工具环境…</div>
      ) : (
        <div className="tool-grid">
          {tools.map((tool) => (
            <ToolCard key={tool.name} tool={tool} onInstall={install} />
          ))}
        </div>
      )}
    </section>
  );
}

interface ToolCardProps {
  tool: ManagedTool;
  onInstall: (name: ToolName) => Promise<void>;
}

function ToolCard({ tool, onInstall }: ToolCardProps) {
  const ready = tool.status === "installed";
  const installing = tool.status === "installing";
  return (
    <article className={`tool-card tool-card--${tool.status}`}>
      <div className="tool-card-icon">
        <Icon name={tool.name === "pdf2zh" ? "languages" : "terminal"} size={22} />
      </div>
      <div className="tool-card-body">
        <div className="tool-card-title">
          <h3>{tool.label}</h3>
          <span className="tool-status"><i />{statusLabels[tool.status]}</span>
        </div>
        <p>{tool.description}</p>
        <div className="tool-card-meta">
          <span title={tool.install_path}>{tool.install_path}</span>
          {tool.version ? <strong>v{tool.version}</strong> : null}
        </div>
        {tool.status === "failed" ? <div className="tool-error-detail">{tool.message}</div> : null}
      </div>
      <button
        className="tool-action"
        type="button"
        disabled={ready || installing}
        onClick={() => void onInstall(tool.name)}
      >
        <Icon name={ready ? "check" : "download"} size={15} />
        {ready ? "可用" : installing ? "安装中" : "下载并安装"}
      </button>
    </article>
  );
}
