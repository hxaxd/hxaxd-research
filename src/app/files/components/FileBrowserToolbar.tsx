'use client';

import './FileBrowserToolbar.css';

import * as Menu from '@radix-ui/react-dropdown-menu';
import { BookOpen, Ellipsis, FolderPlus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'use-intl';

import { requestJson } from '@/shared/http/request-json';
import { CreateEntityDialog } from '@/shared/ui/EntityControls';
import { ImportFilesDialog } from './ImportFilesDialog';

export function FileBrowserToolbar({ workspaceId, papersOnly, onPapersOnlyChange, onChanged, onOpenFile }: {
  workspaceId: string;
  papersOnly: boolean;
  onPapersOnlyChange: (value: boolean) => void;
  onChanged: () => void;
  onOpenFile: (path: string) => void;
}) {
  const t = useTranslations();
  const [creating, setCreating] = useState(false);

  return <div className="file-browser-toolbar">
    <button className="icon-button" aria-pressed={papersOnly} aria-label={t('files.papersOnly')} title={t('files.papersOnly')}
      onClick={() => onPapersOnlyChange(!papersOnly)}>
      <BookOpen size={17} />
    </button>
    <ImportFilesDialog workspaceId={workspaceId} target="" onImported={result => {
      onChanged();
      if (result.main) onOpenFile(result.main);
    }} />
    <Menu.Root modal={false}>
      <Menu.Trigger className="icon-button" aria-label={t('files.materialActions')} title={t('files.materialActions')}><Ellipsis size={17} /></Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu-surface" align="start" sideOffset={6} collisionPadding={8}>
          <Menu.Item className="menu-item" onSelect={() => setCreating(true)}><FolderPlus size={15} />{t('files.createFolder')}</Menu.Item>
          <Menu.Item className="menu-item" onSelect={onChanged}><RefreshCw size={15} />{t('files.refresh')}</Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
    <CreateEntityDialog title={t('files.createFolder')} open={creating} onOpenChange={setCreating} onSubmit={async name => {
      await requestJson<{ path: string }>(`/api/workspaces/${workspaceId}/files`, {
        method: 'POST', body: JSON.stringify({ path: name }),
      });
      toast.success(t('files.folderCreated'));
      onPapersOnlyChange(false);
      onChanged();
    }} />
  </div>;
}
