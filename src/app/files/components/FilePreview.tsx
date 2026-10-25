'use client';

import { useTranslations } from 'use-intl';

import {
  BookOpen,
  Download,
  File,
  FileText,
  FolderOpen,
  RefreshCw,
} from 'lucide-react';
import { useState } from 'react';
import type { ImageClip, DocumentRequest, ViewMode, TextQuote } from '../schema';

import { PdfViewer } from './PdfViewer';
import { TextPreview } from './TextPreview';
import { DocumentSelection } from './DocumentSelection';
import { ImagePreview } from './ImagePreview';

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
  mode,
  onModeChange,
  request,
  onOpenFile,
  onCapture,
  onQuote,
}: {
  workspaceId: string;
  path: string | null;
  revision: number;
  onPageChange: (page: number) => void;
  onBrowse: () => void;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  request: DocumentRequest | null;
  onOpenFile: (path: string) => void;
  onCapture: (clip: ImageClip) => Promise<void>;
  onQuote: (quote: TextQuote) => Promise<void>;
}) {
  const t = useTranslations();
  const [refresh, setRefresh] = useState(0);
  const [textPath, setTextPath] = useState<string | null>(null);
  if (!path)
    return (
      <section className="reader-panel" id="reader-panel" aria-label={t('files.reader')}>
        <div className="panel-heading">
          <span>{t('files.reading')}</span>
        </div>
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
    <section className="reader-panel" id="reader-panel" aria-label={t('files.reader')}>
      <div className="panel-heading reader-heading">
        <div className="resource-heading">
          <FileText size={16} aria-hidden="true" />
          <strong className="resource-name" title={path}>
            {name}
          </strong>
        </div>
        <div className="toolbar">
          {(markdown || html) && (
            <div className="preview-modes" role="group" aria-label={t('files.viewMode')}>
              <button aria-pressed={mode === 'source'} onClick={() => onModeChange('source')}>{t('files.source')}</button>
              <button aria-pressed={mode === 'preview'} onClick={() => onModeChange('preview')}>{t('files.preview')}</button>
            </div>
          )}
          <button
            className="icon-button"
            aria-label={t('files.reloadCurrent')}
            title={t('files.reload')}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={16} />
          </button>
          <a
            className="icon-button"
            href={`${url}&download=1`}
            aria-label={t('files.downloadCurrent')}
            title={t('files.download')}
          >
            <Download size={17} />
          </a>
        </div>
      </div>
      <DocumentSelection key={`${path}:${mode}:${revision}:${refresh}:${request?.id ?? ''}`}
        reading={{ path, ...((markdown || html) ? { mode } : {}) }} onQuote={onQuote}>
        {extension === 'pdf' ? (
          <PdfViewer url={url} onPageChange={onPageChange} initialPage={request?.page ?? 1} onCapture={clip => onCapture({ ...clip, path })} />
        ) : html && mode === 'preview' ? (
          <iframe className="html-preview" title={t('files.htmlPreview')} src={`${previewUrl}?revision=${revision}:${refresh}`} allowFullScreen referrerPolicy="no-referrer" />
        ) : markdown && mode === 'preview' ? (
          <TextPreview url={url} markdown={{ workspaceId, path }} onOpenFile={onOpenFile} />
        ) : html || markdown || textExtensions.has(extension) || textPath === path ? (
          <TextPreview url={url} />
        ) : imageExtensions.has(extension) ? (
          <ImagePreview url={`${url}&revision=${revision}:${refresh}`} path={path} onCapture={onCapture} />
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
