import { Layers2, BookOpen, MessagesSquare } from 'lucide-react';
import { getAppRuntime } from '@/server/app-runtime';
import { listWorkspaces } from '@/features/workspaces/server/workspace-store';
import { WorkspaceList } from '@/features/workspaces/components/WorkspaceList';
import { CreateWorkspaceDialog } from '@/features/workspaces/components/CreateWorkspaceDialog';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export default async function Home() {
  const app = getAppRuntime(); await app.ready;
  const workspaces = listWorkspaces(app.db);
  return <div className="home-shell"><header className="app-header"><div className="brand"><Layers2 size={22} /><span>科研工作台</span></div><div className="header-spacer" /><span className="local-indicator"><i />本地运行</span></header><main className="home-content"><div className="home-intro"><span className="eyebrow">材料 · 阅读 · 对话</span><h1>把材料和思考<br />放在一起。</h1><p>为每个研究主题建立一个工作区。<br />整理论文，阅读文件，让对话围绕实际材料展开。</p></div><div className="workspace-section-heading"><h2>我的工作区 <small>{workspaces.length}</small></h2><CreateWorkspaceDialog /></div>{workspaces.length ? <WorkspaceList workspaces={workspaces} /> : <div className="workspace-empty"><div className="empty-illustration"><BookOpen size={38} strokeWidth={1.2} /><MessagesSquare size={24} strokeWidth={1.2} /></div><h3>你的第一个研究主题</h3><p>新建工作区后，即可加入论文、材料和多段对话。</p></div>}</main><footer className="home-footer">资料保存在本机 · 对话使用已配置的模型服务</footer></div>;
}
