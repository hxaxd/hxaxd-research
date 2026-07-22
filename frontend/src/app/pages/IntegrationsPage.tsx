import { useAppData } from "../AppDataContext";
import { ZoteroTransferWizard } from "../../features/zotero/ZoteroTransferWizard";
import "./pages.css";

export function IntegrationsPage() {
  const { projects } = useAppData();
  return <section className="integrations-page workspace-page"><div className="workspace-content"><header className="page-header compact-page-header"><div><span className="eyebrow">导入与同步</span><h1>连接外部文献库</h1><p>先预览差异和冲突，再由确定性代码执行迁移；任何写入都需要你确认。</p></div></header><ZoteroTransferWizard projects={projects} /></div></section>;
}
