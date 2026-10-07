'use client';
import { Plus } from 'lucide-react';
import { NameDialog } from '@/shared/ui/NameDialog';
import { requestJson } from '@/shared/http/request-json';
import type { Paper } from '../paper-schema';
export function CreatePaperDialog({ workspaceId, onCreated }: { workspaceId: string; onCreated: (paper: Paper) => void }) {
  return <NameDialog title="新建论文" label="论文可以包含 PDF、源码、图片和其他材料。" onSubmit={async (name, id) => {
    onCreated(await requestJson<Paper>(`/api/workspaces/${workspaceId}/papers`, { method: 'POST', body: JSON.stringify({ id, name }) }));
  }}><button className="icon-button" aria-label="新建论文"><Plus size={17} /></button></NameDialog>;
}
