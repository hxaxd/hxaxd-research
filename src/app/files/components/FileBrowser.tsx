'use client';

import './FileBrowser.css';


import { useTranslations } from 'use-intl';

import {
  ArrowLeft,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
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
  const t = useTranslations();
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [view, setView] = useState<'papers' | 'files'>('papers');
  const listDirectory = view === 'papers' ? '' : directory;
  useEffect(() => {
    const controller = new AbortController();
    void requestJson<FileEntry[]>(
      `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(listDirectory)}&view=${view}`,
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
  }, [workspaceId, listDirectory, view, revision, refresh]);
  const navigate = (next: string) => {
    setFiles(null);
    setError('');
    setView('files');
    onDirectoryChange(next);
  };
  return (
    <section className="file-browser">
      <div className="material-views preview-modes" role="group" aria-label={t('files.viewMode')}>
        {(['papers', 'files'] as const).map(value => (
          <button key={value} aria-pressed={view === value} onClick={() => {
            if (value !== view) {
              setFiles(null);
              setView(value);
            }
          }}>{t(`files.${value}`)}</button>
        ))}
      </div>
      <div className="file-actions">
        <CreateEntityDialog title={t('files.createFolder')} onSubmit={async name => {
          const result = await requestJson<{ path: string }>(`/api/workspaces/${workspaceId}/files`, {
            method: 'POST', body: JSON.stringify({ path: listDirectory ? `${listDirectory}/${name}` : name }),
          });
          navigate(result.path);
        }}>
          <button className="icon-button" aria-label={t('files.createFolder')} title={t('files.createFolder')}><FolderPlus size={15} /></button>
        </CreateEntityDialog>
        <ImportFilesDialog
          workspaceId={workspaceId}
          target={listDirectory}
          onImported={() => setRefresh((value) => value + 1)}
        />
        <button
          className="icon-button"
          aria-label={t('files.refresh')}
          title={t('files.refresh')}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      {view === 'files' && directory !== '' && (
        <button
          className="directory-back"
          onClick={() =>
            navigate(directory.slice(0, Math.max(0, directory.lastIndexOf('/'))))
          }
        >
          <ArrowLeft size={14} />
          {t('files.parent')}
        </button>
      )}
      {view === 'files' && directory !== '' && (
        <div className="directory-path" title={directory}>
          {directory}
        </div>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {!error && files === null && <p className="empty-small" role="status">{t('common.loading')}</p>}
      {!error && files?.length === 0 && (
        <div className="empty-small">
          {t(view === 'papers' ? 'files.noPapers' : 'files.empty')}
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
            {view === 'papers' && (
              <button className="icon-button file-folder" aria-label={t('files.openFolder', { name: file.name })}
                title={file.path} onClick={() => navigate(file.path.slice(0, Math.max(0, file.path.lastIndexOf('/'))))}>
                <FolderOpen size={15} />
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
