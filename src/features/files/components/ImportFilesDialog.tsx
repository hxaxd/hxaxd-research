'use client';
import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Upload, X, FolderPlus, FilePlus2 } from 'lucide-react';
import { requestJson } from '@/shared/http/request-json';
import type { ImportResult } from '../file-schema';
export function ImportFilesDialog({ workspaceId, target, onImported }: { workspaceId: string; target: string; onImported: () => void }) {
  const [open, setOpen] = useState(false), [files, setFiles] = useState<File[]>([]), [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submission = useRef<string | null>(null);
  const picker = useRef<HTMLInputElement>(null), directory = useRef<HTMLInputElement>(null);
  function choose(list: FileList | null) {
    const next = Array.from(list ?? []); setFiles(next); submission.current = null; setError('');
    setName(next[0]?.webkitRelativePath.split('/')[0] || (next.length > 1 ? '材料' : ''));
  }
  return <Dialog.Root open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
    <Dialog.Trigger asChild><button className="icon-button" aria-label="导入材料"><Upload size={16} /></button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content">
      <div className="dialog-heading"><Dialog.Title>导入材料</Dialog.Title><Dialog.Close className="icon-button" aria-label="关闭"><X size={18} /></Dialog.Close></div>
      <Dialog.Description className="muted">选择文件或完整目录。目录结构会被保留，已有文件不会被覆盖。</Dialog.Description>
      <input ref={picker} type="file" multiple className="visually-hidden" aria-label="选择材料文件" onChange={event => choose(event.target.files)} />
      <input ref={directory} type="file" multiple className="visually-hidden" aria-label="选择材料目录" {...{ webkitdirectory: '' }} onChange={event => choose(event.target.files)} />
      <div className="import-choices"><button className="button secondary" onClick={() => picker.current?.click()} disabled={busy}><FilePlus2 size={17} />选择文件</button><button className="button secondary" onClick={() => directory.current?.click()} disabled={busy}><FolderPlus size={17} />选择目录</button></div>
      {files.length > 0 && <p className="import-summary">已选 {files.length} 个文件 · {(files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(1)} MiB</p>}
      {(files.length > 1 || !!files[0]?.webkitRelativePath) && <><label className="field-label" htmlFor="import-name">材料目录名称</label><input id="import-name" value={name} onChange={event => { setName(event.target.value); submission.current = null; }} maxLength={160} disabled={busy} /></>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="dialog-actions"><Dialog.Close className="button secondary" disabled={busy}>取消</Dialog.Close><button className="button primary" disabled={busy || !files.length} onClick={async () => {
        setBusy(true); setError(''); submission.current ??= crypto.randomUUID();
        const form = new FormData();
        const folderName = files.length > 1 || files[0]?.webkitRelativePath ? name.trim() : undefined;
        form.append('metadata', JSON.stringify({ requestId: submission.current, target, folderName }));
        for (const file of files) { const relative = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name; form.append('files', file, relative); }
        try { await requestJson<ImportResult>(`/api/workspaces/${workspaceId}/imports`, { method: 'POST', body: form }); submission.current = null; setFiles([]); setOpen(false); onImported(); }
        catch (error) { setError(error instanceof Error ? error.message : '导入失败'); }
        finally { setBusy(false); }
      }}>{busy ? '导入中…' : '导入'}</button></div>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
