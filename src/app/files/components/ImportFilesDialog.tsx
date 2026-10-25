'use client';

import { useTranslations } from 'use-intl';

import * as Dialog from '@radix-ui/react-dialog';
import { FilePlus2, FolderPlus, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';

import { requestJson } from '@/shared/http/request-json';

import type { ImportResult } from '../schema';

export function ImportFilesDialog({
  workspaceId,
  target,
  onImported,
}: {
  workspaceId: string;
  target: string;
  onImported: () => void;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const directory = useRef<HTMLInputElement>(null);
  function choose(list: FileList | null) {
    const next = Array.from(list ?? []);
    setFiles(next);
    setError('');
    setName(next[0]?.webkitRelativePath.split('/')[0] || (next.length > 1 ? t('files.materials') : ''));
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!busy) setOpen(value);
      }}
    >
      <Dialog.Trigger asChild>
        <button className="text-action" aria-label={t('files.importMaterials')}>
          <Upload size={15} aria-hidden="true" />
          <span>{t('common.import')}</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby={undefined}>
          <div className="dialog-heading">
            <Dialog.Title>{t('files.importMaterials')}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={t('common.close')}>
              <X size={18} />
            </Dialog.Close>
          </div>
          <input
            ref={picker}
            type="file"
            multiple
            className="visually-hidden"
            aria-label={t('files.selectFilesLabel')}
            onChange={(event) => choose(event.target.files)}
          />
          <input
            ref={directory}
            type="file"
            multiple
            className="visually-hidden"
            aria-label={t('files.selectDirectoryLabel')}
            {...{ webkitdirectory: '' }}
            onChange={(event) => choose(event.target.files)}
          />
          <div className="import-choices">
            <button
              className="button secondary"
              onClick={() => picker.current?.click()}
              disabled={busy}
            >
              <FilePlus2 size={17} />
              {t('files.selectFiles')}
            </button>
            <button
              className="button secondary"
              onClick={() => directory.current?.click()}
              disabled={busy}
            >
              <FolderPlus size={17} />
              {t('files.selectDirectory')}
            </button>
          </div>
          {files.length > 0 && (
            <p className="import-summary">
              {t('files.selectedFiles', {count: files.length})} ·{' '}
              {(files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(1)} MiB
            </p>
          )}
          {(files.length > 1 || !!files[0]?.webkitRelativePath) && (
            <>
              <label className="field-label" htmlFor="import-name">
                {t('files.materialFolderName')}
              </label>
              <input
                id="import-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                maxLength={160}
                disabled={busy}
              />
            </>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Dialog.Close className="button secondary" disabled={busy}>
              {t('common.cancel')}
            </Dialog.Close>
            <button
              className="button primary"
              disabled={busy || !files.length}
              onClick={async () => {
                setBusy(true);
                setError('');
                const form = new FormData();
                const folderName =
                  files.length > 1 || files[0]?.webkitRelativePath ? name.trim() : undefined;
                form.append('metadata', JSON.stringify({ target, folderName }));
                for (const file of files) {
                  const relative = file.webkitRelativePath
                    ? file.webkitRelativePath.split('/').slice(1).join('/')
                    : file.name;
                  form.append('files', file, relative);
                }
                try {
                  await requestJson<ImportResult>(`/api/workspaces/${workspaceId}/imports`, {
                    method: 'POST',
                    body: form,
                  });
                  setFiles([]);
                  setOpen(false);
                  onImported();
                } catch (error) {
                  setError((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? t('files.importing') : t('common.import')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
