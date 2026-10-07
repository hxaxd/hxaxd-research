'use client';
import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, FileText, Folder, RefreshCw, MessageSquarePlus } from 'lucide-react';
import { requestJson } from '@/shared/http/request-json';
import type { FileEntry } from '../file-schema';
import { ImportFilesDialog } from './ImportFilesDialog';
export function WorkspaceFileTree({ workspaceId, rootPath, onOpenFile, onReference }: { workspaceId: string; rootPath: string; onOpenFile: (path: string) => void; onReference: (path: string) => void }) {
  const [directory, setDirectory] = useState(rootPath), [files, setFiles] = useState<FileEntry[] | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void requestJson<FileEntry[]>(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(directory)}`, { signal: controller.signal }).then(result => { setFiles(result); setError(''); }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [workspaceId, directory, revision]);
  const navigate = (next: string) => { setFiles(null); setError(''); setDirectory(next); };
  return <section className="file-browser">
    <div className="section-heading"><span>材料</span><div className="toolbar"><ImportFilesDialog workspaceId={workspaceId} target={directory} onImported={() => setRevision(value => value + 1)} /><button className="icon-button" aria-label="刷新文件" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} /></button></div></div>
    {directory !== rootPath && <button className="directory-back" onClick={() => navigate(directory.slice(0, Math.max(rootPath.length, directory.lastIndexOf('/'))))}><ArrowLeft size={14} />返回上一级</button>}
    {directory !== rootPath && <div className="directory-path" title={directory}>{directory.slice(rootPath.length).replace(/^\//, '')}</div>}
    {error && <p role="alert" className="error-message">{error}</p>}
    {!error && files === null && <p className="empty-small">读取材料…</p>}
    {!error && files?.length === 0 && <div className="empty-small">还没有材料<br /><span>从上方导入文件或目录。</span></div>}
    <div>{files?.map(file => <div className="file-row" key={file.path}>
      <button className="file-open" title={file.name} onClick={() => file.kind === 'directory' ? navigate(file.path) : onOpenFile(file.path)}>{file.kind === 'directory' ? <Folder size={15} /> : <FileText size={15} />}<span>{file.name}</span>{file.kind === 'directory' && <ChevronRight size={12} />}</button>
      {file.kind === 'file' && <button className="icon-button row-action" aria-label={`引用 ${file.name}`} title="加入对话" onClick={() => onReference(file.path)}><MessageSquarePlus size={14} /></button>}
    </div>)}</div>
  </section>;
}
