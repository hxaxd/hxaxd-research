'use client';

import { ChevronLeft, ChevronRight, Contrast, FileText, ListTree, Minus, Plus, Scan } from 'lucide-react';
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';
import type { PDFViewer as Viewer, PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';

import { useAppearance } from '@/app/settings/components/use-appearance';
import { ChoiceSelect } from '@/shared/ui/ChoiceSelect';
import type { ImageClip } from '../schema';
import { PdfRegionSelection } from './PdfRegionSelection';

type Outline = NonNullable<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>;
type Engine = { viewer: Viewer; links: PDFLinkService };

function subscribeColors(listener: () => void) {
  window.addEventListener('research-pdf-colors', listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener('research-pdf-colors', listener);
    window.removeEventListener('storage', listener);
  };
}

function OutlineItems({ items, navigate }: { items: Outline; navigate: (dest: string | unknown[]) => void }) {
  return (
    <ul>
      {items.map((item, index) => (
        <li key={index}>
          {item.items.length ? (
            <details open>
              <summary>
                <button disabled={!item.dest} onClick={() => navigate(item.dest!)}>{item.title}</button>
              </summary>
              <OutlineItems items={item.items} navigate={navigate} />
            </details>
          ) : (
            <button disabled={!item.dest} onClick={() => navigate(item.dest!)}>{item.title}</button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function PdfViewer({ url, onPageChange, initialPage = 1, onCapture }: { url: string; onPageChange: (page: number) => void; initialPage?: number; onCapture: (clip: Omit<ImageClip, 'path'>) => Promise<void> }) {
  const { resolvedMode } = useAppearance();
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(0);
  const [scale, setScale] = useState('page-width');
  const [mode, setMode] = useState('continuous');
  const colors = useSyncExternalStore(subscribeColors, () => localStorage.getItem('research-pdf-colors'), () => null);
  const [outline, setOutline] = useState<Outline | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [error, setError] = useState('');
  const [selecting, setSelecting] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const notifyPage = useEffectEvent(onPageChange);
  const inverted = (colors ?? resolvedMode) === 'dark';

  useEffect(() => {
    const controller = new AbortController();
    let viewer: Viewer | undefined;
    let task: PDFDocumentLoadingTask | undefined;
    let observer: ResizeObserver | undefined;
    void (async () => {
      const library = await import('pdfjs-dist');
      const { PDFViewer, PDFLinkService, EventBus, ScrollMode } = await import('pdfjs-dist/web/pdf_viewer.mjs');
      if (controller.signal.aborted) return;
      library.GlobalWorkerOptions.workerSrc = '/pdf-assets/pdf.worker.min.mjs';
      const eventBus = new EventBus();
      const links = new PDFLinkService({ eventBus, externalLinkTarget: 2, ignoreDestinationZoom: true });
      const options = {
        container: scroll.current!, viewer: pages.current!, eventBus, linkService: links,
        annotationMode: library.AnnotationMode.ENABLE, abortSignal: controller.signal,
      };
      viewer = new PDFViewer(options);
      links.setViewer(viewer);
      engine.current = { viewer, links };
      eventBus.on('pagesinit', () => {
        const savedMode = localStorage.getItem('research-pdf-mode') ?? 'continuous';
        setMode(savedMode);
        viewer!.scrollMode = savedMode === 'page' ? ScrollMode.PAGE : ScrollMode.VERTICAL;
        viewer!.currentScaleValue = 'page-width';
        setCount(viewer!.pagesCount);
        viewer!.currentPageNumber = Math.min(initialPage, viewer!.pagesCount);
        setPage(viewer!.currentPageNumber);
        notifyPage(viewer!.currentPageNumber);
      });
      eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
        setPage(pageNumber);
        notifyPage(pageNumber);
      });
      eventBus.on('scalechanging', ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
        setScale(presetValue || String(Math.round(scale * 100)));
      });
      eventBus.on('pagerendered', ({ error }: { error?: Error }) => {
        if (error) setError(error.message);
      });
      observer = new ResizeObserver(() => {
        if (!viewer!.pdfDocument) return;
        if (['page-width', 'page-fit'].includes(viewer!.currentScaleValue))
          viewer!.currentScaleValue = viewer!.currentScaleValue;
        viewer!.update();
      });
      observer.observe(scroll.current!);
      let wheelTime = 0;
      scroll.current!.addEventListener('wheel', (event) => {
        if (event.ctrlKey || viewer!.scrollMode !== ScrollMode.PAGE) return;
        const element = scroll.current!;
        const down = event.deltaY > 0;
        const atEdge = down
          ? element.scrollTop + element.clientHeight >= element.scrollHeight - 2
          : element.scrollTop <= 1;
        if (!atEdge || !event.deltaY) return;
        event.preventDefault();
        const now = performance.now();
        if (now - wheelTime < 350) return;
        const next = viewer!.currentPageNumber + (down ? 1 : -1);
        if (next < 1 || next > viewer!.pagesCount) return;
        wheelTime = now;
        viewer!.currentPageNumber = next;
        if (!down) element.scrollTop = element.scrollHeight;
      }, { passive: false, signal: controller.signal });
      task = library.getDocument({ url, cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true,
        standardFontDataUrl: '/pdf-assets/standard_fonts/', wasmUrl: '/pdf-assets/wasm/' });
      const pdf = await task.promise;
      if (controller.signal.aborted) return;
      links.setDocument(pdf);
      viewer.setDocument(pdf);
      const headings = await pdf.getOutline();
      if (!controller.signal.aborted) setOutline(headings ?? []);
    })().catch((error: Error) => {
      if (!controller.signal.aborted) setError(error.message);
    });
    return () => {
      controller.abort();
      observer?.disconnect();
      viewer?.setDocument(null!);
      engine.current = null;
      void task?.destroy();
    };
  }, [url, initialPage]);

  function jumpTo(next: number) {
    engine.current!.viewer.currentPageNumber = Math.max(1, Math.min(count, next));
  }
  function changeMode(next: string) {
    setMode(next);
    localStorage.setItem('research-pdf-mode', next);
    engine.current!.viewer.scrollMode = next === 'page' ? 3 : 0;
  }
  function changeScale(next: string) {
    engine.current!.viewer.currentScaleValue = ['page-width', 'page-fit'].includes(next) ? next : String(Number(next) / 100);
  }
  const scales = [
    { id: 'page-width', name: '适应宽度' }, { id: 'page-fit', name: '适应页面' },
    ...[50, 75, 100, 125, 150, 200, 300].map(value => ({ id: String(value), name: `${value}%` })),
  ];
  if (!scales.some(item => item.id === scale)) scales.push({ id: scale, name: `${scale}%` });

  return (
    <div className={`pdf-viewer pdf-mode-${mode}${inverted ? ' pdf-inverted' : ''}`}>
      <div className="pdf-controls" role="toolbar" aria-label="PDF 阅读工具" inert={selecting}>
        <button className="icon-button" aria-label="目录" title="目录" aria-expanded={outlineOpen}
          onClick={() => setOutlineOpen(value => !value)}><ListTree size={17} /></button>
        <div className="pdf-navigation">
          <button className="icon-button" aria-label="上一页" disabled={!count || page <= 1} onClick={() => jumpTo(page - 1)}><ChevronLeft size={17} /></button>
          <form onSubmit={event => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('page') as HTMLInputElement; jumpTo(Number(input.value)); input.blur(); }}>
            <input key={page} name="page" type="number" min={1} max={count || 1} defaultValue={page} aria-label="跳转页码" disabled={!count} />
            <span>/ {count || '—'}</span>
          </form>
          <button className="icon-button" aria-label="下一页" disabled={!count || page >= count} onClick={() => jumpTo(page + 1)}><ChevronRight size={17} /></button>
        </div>
        <div className="pdf-zoom">
          <button className="icon-button" aria-label="缩小" disabled={!count} onClick={() => engine.current!.viewer.decreaseScale()}><Minus size={16} /></button>
          <ChoiceSelect label="阅读缩放" value={scale} items={scales} onChange={changeScale} disabled={!count} />
          <button className="icon-button" aria-label="放大" disabled={!count} onClick={() => engine.current!.viewer.increaseScale()}><Plus size={16} /></button>
        </div>
        <ChoiceSelect label="阅读方式" value={mode} items={[{ id: 'continuous', name: '连续滚动' }, { id: 'page', name: '单页' }]} onChange={changeMode} disabled={!count} />
        <button className="icon-button" aria-label="页面反色" title="页面反色" aria-pressed={inverted} onClick={() => {
          localStorage.setItem('research-pdf-colors', inverted ? 'light' : 'dark');
          window.dispatchEvent(new Event('research-pdf-colors'));
        }}><Contrast size={17} /></button>
        <button className="pdf-select-button" disabled={!count} aria-pressed={selecting} onClick={() => { setOutlineOpen(false); setSelecting(true); }}><Scan size={17} aria-hidden="true" />框选提问</button>
      </div>
      <div className="pdf-stage">
        {outlineOpen && (
          <nav className="pdf-outline" aria-label="文档目录">
            <div className="pdf-outline-heading"><strong>目录</strong><button className="icon-button" aria-label="关闭目录" onClick={() => setOutlineOpen(false)}><ChevronLeft size={16} /></button></div>
            {outline === null ? <p>正在加载目录…</p> : outline.length ? (
              <OutlineItems items={outline} navigate={dest => { void engine.current!.links.goToDestination(dest).catch((error: Error) => setError(error.message)); setOutlineOpen(false); }} />
            ) : <p>此文档没有内嵌目录</p>}
          </nav>
        )}
        <div className="pdf-scroll" ref={scroll} inert={selecting} tabIndex={0} aria-label="PDF 页面" onKeyDown={event => {
          if (!count || !['PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          jumpTo(event.key === 'Home' ? 1 : event.key === 'End' ? count : page + (event.key === 'PageDown' ? 1 : -1));
        }}>
          <div className="pdfViewer" ref={pages} />
        </div>
        {!count && !error && <div className="pdf-loading" role="status"><FileText size={28} /><span>正在打开 PDF…</span></div>}
        {error && <p role="alert" className="pdf-error error-message">{error}</p>}
        {selecting && <PdfRegionSelection getPage={page => engine.current!.viewer.pdfDocument!.getPage(page)} scroll={scroll} onCapture={onCapture} onClose={() => setSelecting(false)} />}
      </div>
    </div>
  );
}
