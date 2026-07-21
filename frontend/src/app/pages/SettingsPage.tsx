import { useAppData } from "../AppDataContext";
import { OperationsSettings } from "../../features/settings/OperationsSettings";
import { DeviceAccessSettings } from "../../features/device-access/DeviceAccessSettings";
import { WorkspacePreferencesSettings } from "../../features/settings/WorkspacePreferencesSettings";
import { Icon } from "../../shared/ui/Icon";
import "./pages.css";

export function SettingsPage() {
  const { workspace, connection, error, refresh } = useAppData();
  return (
    <section className="workspace-page">
      <div className="workspace-content">
        <header className="page-header compact-page-header">
          <div><span className="eyebrow">SYSTEM</span><h1>设置与运行时</h1><p>低频的工具、能力和诊断信息集中在这里，不打扰日常筛选与阅读。</p></div>
          <button className="toolbar-button" type="button" onClick={() => void refresh()}><Icon name="refresh" size={15} />重新检查</button>
        </header>
        <div className="settings-grid">
          <section className="settings-card">
            <header><Icon name="activity" size={18} /><div><h2>后端连接</h2><p>状态来自工作区接口，不使用静态指示。</p></div></header>
            <dl><dt>状态</dt><dd className={`connection-text connection-text--${connection}`}>{connection}</dd><dt>契约版本</dt><dd>{workspace?.contract_version || "—"}</dd><dt>数据模型</dt><dd>{workspace ? `Schema ${workspace.schema_version}` : "—"}</dd><dt>最近响应</dt><dd>{workspace?.generated_at || error || "—"}</dd></dl>
          </section>
          {Object.entries(workspace?.capabilities ?? {}).map(([key, capability]) => (
            <section className="settings-card" key={key}>
              <header><Icon name={capabilityIcon(key)} size={18} /><div><h2>{capabilityName(key)}</h2><p>{capability.message}</p></div></header>
              <dl>
                <dt>支持</dt><dd>{capability.supported ? "是" : "否"}</dd>
                <dt>就绪</dt><dd className={capability.ready ? "connection-text--connected" : "connection-text--disconnected"}>{capability.ready ? "可用" : "未就绪"}</dd>
                {Object.entries(capability.details).map(([detailKey, value]) => <Detail key={detailKey} name={detailKey} value={value} />)}
              </dl>
            </section>
          ))}
        </div>
        <WorkspacePreferencesSettings />
        <DeviceAccessSettings />
        <OperationsSettings />
      </div>
    </section>
  );
}

function capabilityName(key: string) {
  return ({
    attachment_upload: "附件上传",
    durable_jobs: "持久任务",
    pdf_translation: "PDF 翻译",
    tex_compile: "TeX 编译",
    embedded_agent: "内嵌智能体",
    zotero: "Zotero 迁移",
  } as Record<string, string>)[key] ?? key;
}

function capabilityIcon(key: string): "terminal" | "shield" | "plug" {
  if (key === "pdf_translation" || key === "tex_compile" || key === "embedded_agent") return "terminal";
  return key === "zotero" ? "plug" : "shield";
}

function Detail({ name, value }: { name: string; value: string | number | boolean | null }) {
  const label = ({ version: "版本", executable: "可执行文件", endpoint: "端点" } as Record<string, string>)[name] ?? name;
  return <><dt>{label}</dt><dd>{value === null ? "—" : typeof value === "boolean" ? value ? "是" : "否" : String(value)}</dd></>;
}
