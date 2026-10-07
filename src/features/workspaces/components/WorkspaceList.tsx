import Link from 'next/link';
import { ArrowUpRight, FolderOpen } from 'lucide-react';
import type { Workspace } from '../workspace-schema';
export function WorkspaceList({ workspaces }: { workspaces: Workspace[] }) {
  return <div className="workspace-grid">{workspaces.map(workspace => <Link className="workspace-card" href={`/workspaces/${workspace.id}`} key={workspace.id}>
    <div className="card-icon"><FolderOpen size={21} /><ArrowUpRight size={17} /></div><h2>{workspace.name}</h2><p className="muted">创建于 {new Date(workspace.createdAt).toLocaleDateString('zh-CN')}</p>
  </Link>)}</div>;
}
