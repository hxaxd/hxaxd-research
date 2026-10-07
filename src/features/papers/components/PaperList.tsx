'use client';
import { BookOpen, Pencil, Folder } from 'lucide-react';
import { NameDialog } from '@/shared/ui/NameDialog';
import { requestJson } from '@/shared/http/request-json';
import type { Paper } from '../paper-schema';
export function PaperList({ papers, activeId, workspaceId, onSelect, onRenamed }: { papers: Paper[]; activeId: string | null; workspaceId: string; onSelect: (id: string | null) => void; onRenamed: (paper: Paper) => void }) {
  return <div className="paper-list">
    {papers.map(paper => <div key={paper.id} className={`paper-row ${activeId === paper.id ? 'selected' : ''}`}><button className="paper-select" onClick={() => onSelect(paper.id)}><BookOpen size={16} /><span>{paper.name}</span></button>
      <NameDialog title="重命名论文" label="修改名称不会改变文件位置。" initialName={paper.name} onSubmit={async name => onRenamed(await requestJson<Paper>(`/api/workspaces/${workspaceId}/papers/${paper.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }))}><button className="icon-button row-action" aria-label={`重命名 ${paper.name}`}><Pencil size={13} /></button></NameDialog>
    </div>)}
    <button className={`public-materials ${activeId === null ? 'selected' : ''}`} onClick={() => onSelect(null)}><Folder size={16} /><span>工作区文件</span></button>
  </div>;
}
