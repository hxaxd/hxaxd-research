'use client';

import {
  ArrowLeft,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { CreateEntityDialog } from '@/shared/ui/EntityControls';

import { requestJson } from '@/shared/http/request-json';

import type { FileEntry } from '../schema';
import { ImportFilesDialog } from './ImportFilesDialog';

export function FileBrowser({
  workspaceId,
  directory,
  onDirectoryChange,
  revision,
  activePath,
  onOpenFile,
}: {
  workspaceId: string;
  directory: string;
  onDirectoryChange: (directory: string) => void;
  revision: number;
  activePath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void requestJson<FileEntry[]>(
      `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(directory)}`,
      { signal: controller.signal },
    )
      .then((result) => {
        setFiles(result);
        setError('');
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [workspaceId, directory, revision, refresh]);
  const navigate = (next: string) => {
    setFiles(null);
    setError('');
    onDirectoryChange(next);
  };
  return (
    <section className="file-browser">
      <div className="section-heading">
        <span>
          文件 <small>{files?.length ?? '—'}</small>
        </span>
        <div className="toolbar">
          <CreateEntityDialog title="新建文件夹" label="文件夹名称" onSubmit={async name => {
            const result = await requestJson<{ path: string }>(`/api/workspaces/${workspaceId}/files`, {
              method: 'POST', body: JSON.stringify({ path: directory ? `${directory}/${name}` : name }),
            });
            navigate(result.path);
          }}>
            <button className="icon-button" aria-label="新建文件夹" title="新建文件夹"><FolderPlus size={15} /></button>
          </CreateEntityDialog>
          <ImportFilesDialog
            workspaceId={workspaceId}
            target={directory}
            onImported={() => setRefresh((value) => value + 1)}
          />
          <button
            className="icon-button"
            aria-label="刷新文件"
            title="刷新文件"
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
      {directory !== '' && (
        <button
          className="directory-back"
          onClick={() =>
            navigate(directory.slice(0, Math.max(0, directory.lastIndexOf('/'))))
          }
        >
          <ArrowLeft size={14} />
          返回上一级
        </button>
      )}
      {directory !== '' && (
        <div className="directory-path" title={directory}>
          {directory}
        </div>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {!error && files === null && <p className="empty-small">读取材料…</p>}
      {!error && files?.length === 0 && (
        <div className="empty-small">
          还没有材料
          <br />
          <span>从上方导入文件或目录。</span>
        </div>
      )}
      <div>
        {files?.map((file) => (
          <div className={`file-row${activePath === file.path ? ' selected' : ''}`} key={file.path}>
            <button
              className="file-open"
              title={file.name}
              aria-current={activePath === file.path ? 'true' : undefined}
              onClick={() =>
                file.kind === 'directory' ? navigate(file.path) : onOpenFile(file.path)
              }
            >
              {file.kind === 'directory' ? <Folder size={15} /> : <FileText size={15} />}
              <span>{file.name}</span>
              {file.kind === 'directory' && <ChevronRight size={12} />}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
