'use client';
import { BookOpen, Download, MessageSquarePlus, File, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { PdfViewer } from './PdfViewer';
import { TextFilePreview } from './TextFilePreview';
export function ResourcePreview({ workspaceId, path, onReference }: { workspaceId: string; path: string | null; onReference: (path: string) => void }) {
  const [revision, setRevision] = useState(0);
  if (!path) return <section className="reader-panel"><div className="panel-heading"><span>阅读</span></div><div className="reader-empty"><div className="reader-mark"><BookOpen size={32} strokeWidth={1.3} /></div><h2>从一份材料开始</h2><p>在左侧打开论文或文件。<br />阅读时，随时把材料加入右侧对话。</p><div className="supported-formats"><span>PDF</span><span>TeX</span><span>文本</span><span>图片</span></div></div></section>;
  const name = path.split('/').pop()!;
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const url = `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent(path)}`;
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension);
  const isText = ['tex', 'bib', 'md', 'txt', 'json', 'csv', 'ts', 'tsx', 'js', 'py', 'yaml', 'yml', 'toml', 'xml', 'log', 'sh', 'css', 'r', 'jl'].includes(extension);
  return <section className="reader-panel"><div className="panel-heading"><span className="resource-name" title={path}>{name}</span><div className="toolbar"><button className="icon-button" aria-label="将当前材料加入对话" onClick={() => onReference(path)}><MessageSquarePlus size={17} /></button><a className="icon-button" href={`${url}&download=1`} aria-label="下载当前文件"><Download size={17} /></a></div></div>
    <button className="reader-refresh" aria-label="重新读取当前文件" onClick={() => setRevision(value => value + 1)}><RefreshCw size={13} />重新读取</button>
    <div className="resource-body" key={`${path}:${revision}`}>{extension === 'pdf' ? <PdfViewer url={url} /> : isText ? <TextFilePreview url={url} /> : isImage ? <div className="image-preview"><img src={`${url}&revision=${revision}`} alt={name} /></div> : <div className="reader-empty"><File size={32} /><h2>{name}</h2><p>此类文件可以保存和引用，请下载后打开。</p><a href={`${url}&download=1`} className="button secondary"><Download size={17} />下载文件</a></div>}</div>
  </section>;
}
