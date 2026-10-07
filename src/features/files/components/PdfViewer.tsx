'use client';
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
export function PdfViewer({ url }: { url: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [page, setPage] = useState(1), [scale, setScale] = useState(1.1), [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let destroy: (() => Promise<void>) | undefined;
    void import('pdfjs-dist').then(async library => {
      if (disposed) return;
      library.GlobalWorkerOptions.workerSrc = '/pdf-assets/pdf.worker.min.mjs';
      const task = library.getDocument({ url, cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdf-assets/standard_fonts/', wasmUrl: '/pdf-assets/wasm/' });
      destroy = () => task.destroy();
      try { const document = await task.promise; if (!disposed) setPdf(document); }
      catch (error) { if (!disposed) setError(error instanceof Error ? error.message : 'PDF 无法打开'); }
    }).catch(error => { if (!disposed) setError(error.message); });
    return () => { disposed = true; void destroy?.(); };
  }, [url]);
  useEffect(() => {
    if (!pdf || !canvas.current || !text.current) return;
    let disposed = false, cancel: (() => void) | undefined;
    const element = canvas.current, container = text.current;
    void (async () => {
      const library = await import('pdfjs-dist');
      const current = await pdf.getPage(page);
      if (disposed) return;
      const viewport = current.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      element.width = Math.floor(viewport.width * ratio); element.height = Math.floor(viewport.height * ratio);
      element.style.width = `${viewport.width}px`; element.style.height = `${viewport.height}px`;
      container.replaceChildren();
      container.style.setProperty('--total-scale-factor', String(scale));
      const render = current.render({ canvas: element, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      const layer = new library.TextLayer({ textContentSource: await current.getTextContent(), container, viewport });
      cancel = () => { render.cancel(); layer.cancel(); };
      if (disposed) { cancel(); return; }
      await Promise.all([render.promise, layer.render()]);
    })().catch(error => { if (!disposed) setError(error.message); });
    return () => { disposed = true; cancel?.(); };
  }, [pdf, page, scale]);
  return <div className="pdf-viewer">
    <div className="pdf-controls"><button className="icon-button" aria-label="上一页" disabled={!pdf || page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={17} /></button><span className="page-count">{pdf ? `${page} / ${pdf.numPages}` : '加载中'}</span><button className="icon-button" aria-label="下一页" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(value => value + 1)}><ChevronRight size={17} /></button><span className="toolbar-divider" /><button className="icon-button" aria-label="缩小" disabled={scale <= .5} onClick={() => setScale(value => Math.max(.5, value - .15))}><Minus size={16} /></button><span className="page-count">{Math.round(scale * 100)}%</span><button className="icon-button" aria-label="放大" disabled={scale >= 2.5} onClick={() => setScale(value => Math.min(2.5, value + .15))}><Plus size={16} /></button></div>
    {error ? <p role="alert" className="error-message">{error}</p> : <div className="pdf-scroll"><div className="pdf-page"><canvas ref={canvas} /><div ref={text} className="textLayer" /></div></div>}
  </div>;
}
