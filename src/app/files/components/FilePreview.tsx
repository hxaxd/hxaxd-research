'use client';

import './FilePreview.css';


import { useTranslations } from 'use-intl';
import * as Menu from '@radix-ui/react-dropdown-menu';

import {
  BookOpen,
  Download,
  Ellipsis,
  File,
  FileText,
  FolderOpen,
  RefreshCw,
} from 'lucide-react';
import { useState } from 'react';
import type { ImageClip, PdfPageRequest, ViewMode, TextQuote } from '../schema';

import { PdfViewer } from './PdfViewer';
import { TextPreview } from './TextPreview';
import { DocumentSelection } from './DocumentSelection';
import { ImagePreview } from './ImagePreview';
import { HtmlPreview } from './HtmlPreview';

const textExtensions = new Set([
  'tex',
  'bib',
  'md',
  'txt',
  'json',
  'csv',
  'ts',
  'tsx',
  'js',
  'py',
  'yaml',
  'yml',
  'toml',
  'xml',
  'log',
  'sh',
  'css',
  'r',
  'jl',
]);
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);

export function FilePreview({
  workspaceId,
  path,
  revision,
  onPageChange,
  onBrowse,
  onReload,
  mode,
  pageRequest,
  onOpenFile,
  onCapture,
  onQuote,
}: {
  workspaceId: string;
  path: string | null;
  revision: number;
  onPageChange: (page: number, request?: PdfPageRequest) => void;
  onBrowse: () => void;
  onReload: () => void;
  mode: ViewMode;
  pageRequest: PdfPageRequest | null;
  onOpenFile: (path: string) => void;
  onCapture: (clip: ImageClip) => Promise<void>;
  onQuote: (quote: TextQuote) => Promise<void>;
}) {
  const t = useTranslations();
  const [textPath, setTextPath] = useState<string | null>(null);
  if (!path)
    return (
      <section className="reader-panel" id="reader-panel" aria-label={t('files.reader')}>
        <div className="reader-empty">
          <div className="reader-mark">
            <BookOpen size={36} strokeWidth={1.4} aria-hidden="true" />
          </div>
          <h2>{t('files.noneOpen')}</h2>
          <button className="button secondary" onClick={onBrowse}>
            <FolderOpen size={16} aria-hidden="true" />
            {t('files.browse')}
          </button>
        </div>
      </section>
    );

  const name = path.split('/').pop()!;
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const url = `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`;
  const markdown = ['md', 'markdown'].includes(extension);
  const html = ['html', 'htm'].includes(extension);
  const previewUrl = `/api/workspaces/${workspaceId}/preview/${path.split('/').map(encodeURIComponent).join('/')}`;
  return (
    <section className="reader-panel" id="reader-panel" aria-label={t('files.reader')}
      data-resize-mode={extension === 'pdf' ? 'deferred' : undefined}>
      <DocumentSelection key={`${path}:${mode}:${revision}`}
        reading={{ path, ...((markdown || html) ? { mode } : {}) }} onQuote={onQuote}>
        {extension === 'pdf' ? (
          <PdfViewer url={url} onPageChange={onPageChange} pageRequest={pageRequest?.path === path ? pageRequest : null}
            onCapture={clip => onCapture({ ...clip, path })}
            fileActions={<FileMenuItems url={url} onReload={onReload} />} />
        ) : html && mode === 'preview' ? (
          <HtmlPreview url={`${previewUrl}?revision=${revision}`} />
        ) : markdown && mode === 'preview' ? (
          <TextPreview url={url} markdown={{ workspaceId, path, onOpenFile }} />
        ) : html || markdown || textExtensions.has(extension) || textPath === path ? (
          <TextPreview url={url} />
        ) : imageExtensions.has(extension) ? (
          <ImagePreview url={`${url}&revision=${revision}`} path={path} onCapture={onCapture} />
        ) : (
          <div className="reader-empty">
            <File size={36} aria-hidden="true" />
            <h2>{name}</h2>
            <p>{t('files.unsupported')}</p>
            <button className="button secondary" onClick={() => setTextPath(path)}>
              <FileText size={17} aria-hidden="true" />
              {t('files.asText')}
            </button>
            <a href={`${url}&download=1`} className="button secondary">
              <Download size={17} aria-hidden="true" />
              {t('files.download')}
            </a>
          </div>
        )}
      </DocumentSelection>
    </section>
  );
}

function FileMenuItems({ url, onReload }: { url: string; onReload: () => void }) {
  const t = useTranslations();
  return <>
    <Menu.Item className="menu-item" onSelect={onReload}>
      <RefreshCw size={16} aria-hidden="true" />{t('files.reload')}
    </Menu.Item>
    <Menu.Item className="menu-item" asChild>
      <a href={`${url}&download=1`}><Download size={16} aria-hidden="true" />{t('files.download')}</a>
    </Menu.Item>
  </>;
}

export function FilePreviewHeader({ workspaceId, path, mode, onModeChange, onReload, toolbarRef }: {
  workspaceId: string;
  path: string | null;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  onReload: () => void;
  toolbarRef: (element: HTMLDivElement | null) => void;
}) {
  const t = useTranslations();
  const name = path?.split('/').pop();
  return <div className="reader-heading" hidden={!path}>
    <span className="reader-title" title={path ?? undefined}>{name}</span>
    {/\.(md|markdown|html?)$/i.test(path ?? '') && <div className="preview-modes" role="group" aria-label={t('files.viewMode')}>
      <button aria-pressed={mode === 'preview'} onClick={() => onModeChange('preview')}>{t('files.preview')}</button>
      <button aria-pressed={mode === 'source'} onClick={() => onModeChange('source')}>{t('files.source')}</button>
    </div>}
    <div className="reader-tools" ref={toolbarRef} />
    {path && !/\.pdf$/i.test(path) && <Menu.Root modal={false}>
      <Menu.Trigger className="icon-button" aria-label={t('files.actions')} title={t('files.actions')}>
        <Ellipsis size={18} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu-surface" align="end" sideOffset={6}>
          <Menu.Label className="menu-label file-menu-name">{path}</Menu.Label>
          <FileMenuItems url={`/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`} onReload={onReload} />
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>}
  </div>;
}
