'use client';

import {
  BookOpen,
  Download,
  File,
  FileText,
  FolderOpen,
  RefreshCw,
} from 'lucide-react';
import { useState } from 'react';
import type { ImageClip, ReaderRequest, ViewMode, TextQuote } from '../schema';

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
  request: ReaderRequest | null;
  onOpenFile: (path: string) => void;
  onCapture: (clip: ImageClip) => Promise<void>;
  onQuote: (quote: TextQuote) => Promise<void>;
}) {
  const [refresh, setRefresh] = useState(0);
  const [textPath, setTextPath] = useState<string | null>(null);
  if (!path)
    return (
      <section className="reader-panel" id="reader-panel" aria-label="材料阅读">
        <div className="panel-heading">
          <span>阅读</span>
        </div>
        <div className="reader-empty">
          <div className="reader-mark">
            <BookOpen size={36} strokeWidth={1.4} aria-hidden="true" />
          </div>
          <h2>打开一份材料</h2>
          <p>在材料栏中选择或导入文件。</p>
          <button className="button secondary" onClick={onBrowse}>
            <FolderOpen size={16} aria-hidden="true" />
            选择材料
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
    <section className="reader-panel" id="reader-panel" aria-label="材料阅读">
      <div className="panel-heading reader-heading">
        <div className="resource-heading">
          <FileText size={16} aria-hidden="true" />
          <strong className="resource-name" title={path}>
            {name}
          </strong>
        </div>
        <div className="toolbar">
          {(markdown || html) && (
            <div className="preview-modes" role="group" aria-label="文档显示方式">
              <button aria-pressed={mode === 'source'} onClick={() => onModeChange('source')}>源码</button>
              <button aria-pressed={mode === 'preview'} onClick={() => onModeChange('preview')}>预览</button>
            </div>
          )}
          <button
            className="icon-button"
            aria-label="重新读取当前文件"
            title="重新读取文件"
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={16} />
          </button>
          <a
            className="icon-button"
            href={`${url}&download=1`}
            aria-label="下载当前文件"
            title="下载文件"
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
          <iframe className="html-preview" title="HTML 预览" src={`${previewUrl}?revision=${revision}:${refresh}`} allowFullScreen referrerPolicy="no-referrer" />
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
            <p>可尝试文本预览，或下载到本机打开。</p>
            <button className="button secondary" onClick={() => setTextPath(path)}>
              <FileText size={17} aria-hidden="true" />
              以文本预览
            </button>
            <a href={`${url}&download=1`} className="button secondary">
              <Download size={17} aria-hidden="true" />
              下载文件
            </a>
          </div>
        )}
      </DocumentSelection>
    </section>
  );
}
