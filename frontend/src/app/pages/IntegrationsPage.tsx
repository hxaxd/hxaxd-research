import { useAppData } from "../AppDataContext";
import { ZoteroTransferWizard } from "../../features/zotero/ZoteroTransferWizard";
import "./pages.css";

export function IntegrationsPage() {
  const { projects } = useAppData();
  return <section className="workspace-page"><div className="workspace-content"><header className="page-header compact-page-header"><div><span className="eyebrow">INTEGRATIONS</span><h1>外部文献库</h1><p>双向迁移由确定性代码执行，任何写入都先展示差异并要求确认。</p></div></header><ZoteroTransferWizard projects={projects} /></div></section>;
}
