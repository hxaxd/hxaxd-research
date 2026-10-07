'use client';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { NameDialog } from '@/shared/ui/NameDialog';
import { requestJson } from '@/shared/http/request-json';
import type { Workspace } from '../workspace-schema';
export function CreateWorkspaceDialog({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  return <NameDialog title="新建工作区" label="为一个研究主题建立独立的材料与对话空间。" onSubmit={async (name, id) => {
    const workspace = await requestJson<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ id, name }) });
    router.push(`/workspaces/${workspace.id}`); router.refresh();
  }}><button className={compact ? 'icon-button' : 'button primary'} aria-label="新建工作区"><Plus size={18} />{!compact && '新建工作区'}</button></NameDialog>;
}
