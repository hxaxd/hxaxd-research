'use client';

import './FileTree.css';

import * as Menu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import { BookMarked, BookOpen, ChevronRight, Ellipsis, FileText, Folder, FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'use-intl';

import { requestJson } from '@/shared/http/request-json';
import type { FileEntry } from '../schema';

type TreeProps = {
  workspaceId: string;
  revision: number;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onChanged: () => void;
};

export function useFileList(workspaceId: string, params: Record<string, string>, revision: number, enabled = true) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState('');
  const query = new URLSearchParams(params).toString();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void requestJson<FileEntry[]>(`/api/workspaces/${workspaceId}/files?${query}`, { signal: controller.signal })
      .then(result => { setFiles(result); setError(''); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [workspaceId, query, revision, enabled]);
  return { files, error };
}

export function FileTree({ directory, ...props }: TreeProps & { directory: string }) {
  const t = useTranslations();
  const { files, error } = useFileList(props.workspaceId, { path: directory }, props.revision);
  return <div className={clsx('file-tree', !directory && 'file-tree-root')}>
    {error && <p className="error-message" role="alert">{error}</p>}
    {!error && files === null && <p className="empty-small" role="status">{t('common.loading')}</p>}
    {!error && files?.length === 0 && <p className="empty-small">{t('files.empty')}</p>}
    {files?.map(file => file.kind === 'directory'
      ? <FileTreeFolder key={file.path} file={file} {...props} />
      : <FileRow key={file.path} file={file} activePath={props.activePath} onOpenFile={props.onOpenFile} />)}
  </div>;
}

export function FileRow({ file, activePath, onOpenFile, showPath }: {
  file: FileEntry; activePath: string | null; onOpenFile: (path: string) => void; showPath?: boolean;
}) {
  const active = activePath === file.path;
  return <button className={clsx('file-open', active && 'selected')} title={file.path}
    aria-current={active ? 'true' : undefined} onClick={() => onOpenFile(file.path)}>
    <FileText size={15} aria-hidden="true" />
    <span>{file.name}</span>
    {showPath && file.path.includes('/') && <small className="file-location">{file.path.slice(0, file.path.lastIndexOf('/'))}</small>}
  </button>;
}

/**
 * A folder row. Paper folders show their title and open the main PDF on click;
 * the chevron reveals the folder's files (translations, notes, sources).
 */
export function FileTreeFolder({ file, showPath, ...props }: TreeProps & { file: FileEntry; showPath?: boolean }) {
  const t = useTranslations();
  const inside = !!props.activePath?.startsWith(`${file.path}/`);
  const [open, setOpen] = useState(() => inside && file.marker?.type !== 'paper');
  const paper = file.marker?.type === 'paper' ? file.marker : undefined;
  const main = paper?.main;
  const active = !!main && props.activePath === main;
  const toggle = () => setOpen(value => !value);
  async function mark(type: 'paper' | null) {
    try {
      await requestJson(`/api/workspaces/${props.workspaceId}/files`, {
        method: 'PATCH', body: JSON.stringify({ path: file.path, type }),
      });
      toast.success(t(type ? 'files.markedPaper' : 'files.unmarkedPaper'));
      props.onChanged();
    } catch (error) {
      toast.error((error as Error).message);
    }
  }
  return <div className={clsx('file-tree-folder', paper && 'is-paper', open && 'is-open')}>
    <div className={clsx('file-tree-row', (active || (inside && !open)) && 'selected')}>
      <button className="folder-toggle" aria-label={t(open ? 'common.collapse' : 'common.expand')}
        aria-expanded={open} onClick={toggle}>
        <ChevronRight className="folder-chevron" size={13} aria-hidden="true" />
      </button>
      <button className="file-open" title={paper?.title ?? file.path}
        aria-current={active ? 'true' : undefined}
        onClick={() => main ? props.onOpenFile(main) : toggle()}>
        {paper ? <BookOpen size={15} aria-hidden="true" />
          : open ? <FolderOpen size={15} aria-hidden="true" /> : <Folder size={15} aria-hidden="true" />}
        <span>{paper?.title || file.name}</span>
        {showPath && file.path.includes('/') && <small className="file-location">{file.path.slice(0, file.path.lastIndexOf('/'))}</small>}
      </button>
      <Menu.Root modal={false}>
        <Menu.Trigger className="icon-button folder-menu" aria-label={t('files.folderActions')} title={t('files.folderActions')}>
          <Ellipsis size={14} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className="menu-surface" align="end" sideOffset={4} collisionPadding={8}>
            {main && <Menu.Item className="menu-item" onSelect={() => props.onOpenFile(main)}>
              <FileText size={15} />{t('files.openMain')}</Menu.Item>}
            <Menu.Item className="menu-item" onSelect={() => setOpen(true)}><FolderOpen size={15} />{t('files.openFolder')}</Menu.Item>
            <Menu.Item className="menu-item" onSelect={() => void mark(paper ? null : 'paper')}>
              <BookMarked size={15} />{t(paper ? 'files.unmarkPaper' : 'files.markPaper')}
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </div>
    {open && <FileTree {...props} directory={file.path} />}
  </div>;
}
