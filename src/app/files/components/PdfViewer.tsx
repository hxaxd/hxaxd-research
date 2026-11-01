'use client';

import './PdfViewer.css';

import { ReaderToolbar } from './ReaderToolbar';


import { useTranslations } from 'use-intl';
import * as Popover from '@radix-ui/react-popover';

import { ChevronLeft, ChevronRight, Contrast, FileText, ListTree, Minus, Plus, Scan, SlidersHorizontal } from 'lucide-react';
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';
import { clsx } from 'clsx';
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
  const t = useTranslations();
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
    const pageHost = pages.current!;
    let viewer: Viewer | undefined;
    let task: PDFDocumentLoadingTask | undefined;
    let observer: ResizeObserver | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      const library = await import('pdfjs-dist');
      const { PDFViewer, PDFLinkService, EventBus, ScrollMode } = await import('pdfjs-dist/web/pdf_viewer.mjs');
      if (controller.signal.aborted) return;
      setCount(0);
      setError('');
      setOutline(null);
      scroll.current!.scrollTop = 0;
      library.GlobalWorkerOptions.workerSrc = '/pdf-assets/pdf.worker.min.mjs';
      const eventBus = new EventBus();
      const links = new PDFLinkService({ eventBus, externalLinkTarget: 2, ignoreDestinationZoom: true });
      const options = {
        container: scroll.current!, viewer: pageHost, eventBus, linkService: links,
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
        // Cancelled renders (scroll, resize, document switch) are not failures.
        if (error && !/RenderingCancelled|cancelled|Transport destroyed|pdfPage is not loaded/i.test(error.message))
          setError(error.message);
      });
      observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (!viewer!.pdfDocument) return;
          if (['page-width', 'page-fit'].includes(viewer!.currentScaleValue))
            viewer!.currentScaleValue = viewer!.currentScaleValue;
          viewer!.update();
        }, 100);
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
      clearTimeout(resizeTimer);
      const current = engine.current;
      engine.current = null;
      try {
        // Stop the render queue first, then detach the document, so page views are never
        // asked to draw after their page proxy is gone.
        current?.viewer.cleanup();
        current?.links.setDocument(null);
        current?.viewer.setDocument(null!);
      } catch {
        // The viewer may already be torn down by its own abort signal.
      }
      // Page DOM outlives the viewer object, so clear it before the next document attaches.
      pageHost.replaceChildren();
      const loading = task;
      if (!loading) return;
      void (async () => {
        // Page requests issued while the viewer closed still need the transport.
        // Destroying it earlier rejects them and logs "Transport destroyed".
        await Promise.race([
          loading.promise.catch(() => undefined),
          new Promise(resolve => setTimeout(resolve, 1500)),
        ]);
        await new Promise(resolve => setTimeout(resolve, 400));
        try {
          await loading.destroy();
        } catch {
          // A destroyed transport is the expected outcome of closing a document.
        }
      })();
    };
  // The initial page only changes with a new request, which remounts the viewer through FilePreview's key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

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
  function invertColors() {
    localStorage.setItem('research-pdf-colors', inverted ? 'light' : 'dark');
    window.dispatchEvent(new Event('research-pdf-colors'));
  }
  const scales = [
    { id: 'page-width', name: t('files.fitWidth') }, { id: 'page-fit', name: t('files.fitPage') },
    ...[50, 75, 100, 125, 150, 200, 300].map(value => ({ id: String(value), name: `${value}%` })),
  ];
  if (!scales.some(item => item.id === scale)) scales.push({ id: scale, name: `${scale}%` });

  return (
    <div className={clsx('pdf-viewer', `pdf-mode-${mode}`, inverted && 'pdf-inverted')}>
      <ReaderToolbar>
      <div className="pdf-controls" role="toolbar" aria-label={t('files.pdfTools')} inert={selecting}>
        <button className="icon-button" aria-label={t('files.outline')} title={t('files.outline')} aria-expanded={outlineOpen}
          onClick={() => setOutlineOpen(value => !value)}><ListTree size={17} /></button>
        <div className="pdf-navigation">
          <button className="icon-button" aria-label={t('files.previousPage')} disabled={!count || page <= 1} onClick={() => jumpTo(page - 1)}><ChevronLeft size={17} /></button>
          <form onSubmit={event => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('page') as HTMLInputElement; jumpTo(Number(input.value)); input.blur(); }}>
            <input key={page} name="page" type="number" min={1} max={count || 1} defaultValue={page} aria-label={t('files.goToPage')} disabled={!count} />
            <span>/ {count || '—'}</span>
          </form>
          <button className="icon-button" aria-label={t('files.nextPage')} disabled={!count || page >= count} onClick={() => jumpTo(page + 1)}><ChevronRight size={17} /></button>
        </div>
        <div className="pdf-zoom pdf-wide">
          <button className="icon-button" aria-label={t('files.zoomOut')} disabled={!count} onClick={() => engine.current!.viewer.decreaseScale()}><Minus size={16} /></button>
          <ChoiceSelect label={t('files.zoom')} value={scale} items={scales} onChange={changeScale} disabled={!count} />
          <button className="icon-button" aria-label={t('files.zoomIn')} disabled={!count} onClick={() => engine.current!.viewer.increaseScale()}><Plus size={16} /></button>
        </div>
        <span className="pdf-wide"><ChoiceSelect label={t('files.scrollMode')} value={mode} items={[{ id: 'continuous', name: t('files.continuous') }, { id: 'page', name: t('files.singlePage') }]} onChange={changeMode} disabled={!count} /></span>
        <button className="icon-button pdf-wide" aria-label={t('files.invert')} title={t('files.invert')} aria-pressed={inverted} onClick={invertColors}><Contrast size={17} /></button>
        <button className="pdf-select-button" disabled={!count} aria-label={t('files.capture')} title={t('files.capture')} aria-pressed={selecting} onClick={() => { setOutlineOpen(false); setSelecting(true); }}><Scan size={17} aria-hidden="true" /><span>{t('files.capture')}</span></button>
        <Popover.Root>
          <Popover.Trigger className="icon-button pdf-options" aria-label={t('files.pdfOptions')} title={t('files.pdfOptions')} disabled={!count}><SlidersHorizontal size={17} /></Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="pdf-options-panel menu-surface" side="bottom" align="end" sideOffset={8} collisionPadding={10} aria-label={t('files.pdfOptions')}>
              <div className="pdf-options-zoom">
                <button className="icon-button" aria-label={t('files.zoomOut')} onClick={() => engine.current!.viewer.decreaseScale()}><Minus size={16} /></button>
                <span>{scales.find(item => item.id === scale)!.name}</span>
                <button className="icon-button" aria-label={t('files.zoomIn')} onClick={() => engine.current!.viewer.increaseScale()}><Plus size={16} /></button>
              </div>
              <div className="pdf-options-scales" role="group" aria-label={t('files.zoom')}>
                {scales.map(item => <button key={item.id} aria-pressed={scale === item.id} onClick={() => changeScale(item.id)}>{item.name}</button>)}
              </div>
              <div className="preview-modes" role="group" aria-label={t('files.scrollMode')}>
                <button aria-pressed={mode === 'continuous'} onClick={() => changeMode('continuous')}>{t('files.continuous')}</button>
                <button aria-pressed={mode === 'page'} onClick={() => changeMode('page')}>{t('files.singlePage')}</button>
              </div>
              <button className="menu-item" aria-pressed={inverted} onClick={invertColors}><Contrast size={17} aria-hidden="true" />{t('files.invert')}</button>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
      </ReaderToolbar>
      <div className="pdf-stage">
        {outlineOpen && (
          <nav className="pdf-outline" aria-label={t('files.documentOutline')}>
            <div className="pdf-outline-heading"><strong>{t('files.outline')}</strong><button className="icon-button" aria-label={t('files.closeOutline')} onClick={() => setOutlineOpen(false)}><ChevronLeft size={16} /></button></div>
            {outline === null ? <p>{t('files.outlineLoading')}</p> : outline.length ? (
              <OutlineItems items={outline} navigate={dest => { void engine.current!.links.goToDestination(dest).catch((error: Error) => setError(error.message)); setOutlineOpen(false); }} />
            ) : <p>{t('files.noOutline')}</p>}
          </nav>
        )}
        <div className="pdf-scroll" ref={scroll} inert={selecting} tabIndex={0} aria-label={t('files.pdfPages')} onKeyDown={event => {
          if (!count || !['PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          jumpTo(event.key === 'Home' ? 1 : event.key === 'End' ? count : page + (event.key === 'PageDown' ? 1 : -1));
        }}>
          <div className="pdfViewer" ref={pages} />
        </div>
        {!count && !error && <div className="pdf-loading" role="status"><FileText size={28} /><span>{t('files.pdfLoading')}</span></div>}
        {error && <p role="alert" className="pdf-error error-message">{error}</p>}
        {selecting && <PdfRegionSelection getPage={page => engine.current!.viewer.pdfDocument!.getPage(page)} scroll={scroll} onCapture={onCapture} onClose={() => setSelecting(false)} />}
      </div>
    </div>
  );
}
