'use client';

import './PdfViewer.css';

import { ReaderToolbar } from './ReaderToolbar';


import { useTranslations } from 'use-intl';
import * as Menu from '@radix-ui/react-dropdown-menu';

import { Check, ChevronLeft, ChevronRight, Ellipsis, FileText, ListTree, Minus, Plus, Scan } from 'lucide-react';
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';
import { clsx } from 'clsx';
import type { PDFViewer as Viewer, PDFLinkService } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { useAppearance } from '@/app/settings/components/use-appearance';
import type { ImageClip, PdfPageRequest } from '../schema';
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

function PdfMenuChoice({ value, disabled, children }: { value: string; disabled?: boolean; children: ReactNode }) {
  return <Menu.RadioItem className="menu-item pdf-menu-choice" value={value} disabled={disabled}>
    <span>{children}</span>
    <Menu.ItemIndicator><Check size={16} aria-hidden="true" /></Menu.ItemIndicator>
  </Menu.RadioItem>;
}

export function PdfViewer({ url, onPageChange, pageRequest, onCapture, fileActions }: {
  url: string;
  onPageChange: (page: number, request?: PdfPageRequest) => void;
  pageRequest: PdfPageRequest | null;
  onCapture: (clip: Omit<ImageClip, 'path'>) => Promise<void>;
  fileActions: ReactNode;
}) {
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
  const pageKey = `research-pdf-page:${url}`;
  const currentRequest = useEffectEvent(() => pageRequest);
  const reportPage = useEffectEvent((pageNumber: number, request?: PdfPageRequest) => {
    setPage(pageNumber);
    try {
      localStorage.setItem(pageKey, String(pageNumber));
    } catch {
      // Navigation still works when browser storage is unavailable.
    }
    onPageChange(pageNumber, request);
  });
  const colorMode = colors === 'light' || colors === 'dark' ? colors : 'appearance';
  const inverted = (colorMode === 'appearance' ? resolvedMode : colorMode) === 'dark';

  useEffect(() => {
    const controller = new AbortController();
    const pageHost = pages.current!;
    let viewer: Viewer | undefined;
    let task: PDFDocumentLoadingTask | undefined;
    let observer: ResizeObserver | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let ready = false;
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
        const request = currentRequest();
        let savedPage = 1;
        if (!request) {
          try {
            const saved = Number(localStorage.getItem(pageKey));
            if (Number.isSafeInteger(saved) && saved > 0) savedPage = saved;
          } catch {
            // Start on the first page when browser storage is unavailable.
          }
        }
        const savedMode = localStorage.getItem('research-pdf-mode') ?? 'continuous';
        setMode(savedMode);
        viewer!.scrollMode = savedMode === 'page' ? ScrollMode.PAGE : ScrollMode.VERTICAL;
        viewer!.currentScaleValue = 'page-width';
        setCount(viewer!.pagesCount);
        viewer!.currentPageNumber = Math.min(request?.page ?? savedPage, viewer!.pagesCount);
        ready = true;
        reportPage(viewer!.currentPageNumber, request ?? undefined);
      });
      eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
        if (ready && !controller.signal.aborted) reportPage(pageNumber);
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
  }, [url, pageKey]);

  useEffect(() => {
    const viewer = engine.current?.viewer;
    if (!pageRequest || !viewer?.pagesCount) return;
    viewer.scrollPageIntoView({ pageNumber: Math.min(pageRequest.page, viewer.pagesCount) });
    reportPage(viewer.currentPageNumber, pageRequest);
  }, [pageRequest]);

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
  function changeColors(next: string) {
    if (next === 'appearance') localStorage.removeItem('research-pdf-colors');
    else localStorage.setItem('research-pdf-colors', next);
    window.dispatchEvent(new Event('research-pdf-colors'));
  }
  function startCapture() {
    setOutlineOpen(false);
    setSelecting(true);
  }
  const fitScales = [{ id: 'page-width', name: t('files.fitWidth') }, { id: 'page-fit', name: t('files.fitPage') }];
  const zoomLevels = ['50', '75', '100', '125', '150', '200', '300'];
  if (/^\d+$/.test(scale) && !zoomLevels.includes(scale)) {
    zoomLevels.push(scale);
    zoomLevels.sort((a, b) => Number(a) - Number(b));
  }
  const scaleLabel = fitScales.find(item => item.id === scale)?.name ?? `${scale}%`;
  const colorChoices = [
    { id: 'appearance', name: t('files.followAppearance') },
    { id: 'light', name: t('settings.light') },
    { id: 'dark', name: t('settings.dark') },
  ];
  const colorLabel = colorChoices.find(item => item.id === colorMode)!.name;

  return (
    <div className={clsx('pdf-viewer', `pdf-mode-${mode}`, inverted && 'pdf-inverted')}>
      <ReaderToolbar>
      <div className="pdf-controls" role="toolbar" aria-label={t('files.pdfTools')} inert={selecting}>
        <button className="icon-button pdf-toolbar-extra" aria-label={t('files.outline')} title={t('files.outline')} aria-expanded={outlineOpen} disabled={!count}
          onClick={() => setOutlineOpen(value => !value)}><ListTree size={17} /></button>
        <div className="pdf-navigation">
          <button className="icon-button" aria-label={t('files.previousPage')} disabled={!count || page <= 1} onClick={() => jumpTo(page - 1)}><ChevronLeft size={17} /></button>
          <form onSubmit={event => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('page') as HTMLInputElement; jumpTo(Number(input.value)); input.blur(); }}>
            <input key={page} name="page" type="number" min={1} max={count || 1} defaultValue={page} aria-label={t('files.goToPage')} disabled={!count} />
            <span>/ {count || '—'}</span>
          </form>
          <button className="icon-button" aria-label={t('files.nextPage')} disabled={!count || page >= count} onClick={() => jumpTo(page + 1)}><ChevronRight size={17} /></button>
        </div>
        <button className="icon-button pdf-toolbar-extra" disabled={!count} aria-label={t('files.capture')} title={t('files.capture')} onClick={startCapture}>
          <Scan size={17} aria-hidden="true" />
        </button>
        <Menu.Root modal={false}>
          <Menu.Trigger className="icon-button" aria-label={t('files.pdfOptions')} title={t('files.pdfOptions')}><Ellipsis size={18} /></Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="menu-surface pdf-menu" align="end" sideOffset={6} collisionPadding={10} aria-label={t('files.pdfOptions')}>
              <Menu.RadioGroup value={mode} onValueChange={changeMode} aria-label={t('files.scrollMode')}>
                <PdfMenuChoice value="continuous" disabled={!count}>{t('files.continuous')}</PdfMenuChoice>
                <PdfMenuChoice value="page" disabled={!count}>{t('files.singlePage')}</PdfMenuChoice>
              </Menu.RadioGroup>
              <Menu.Separator className="menu-separator" />
              <Menu.RadioGroup value={scale} onValueChange={changeScale} aria-label={t('files.zoom')}>
                {fitScales.map(item => <PdfMenuChoice key={item.id} value={item.id} disabled={!count}>{item.name}</PdfMenuChoice>)}
              </Menu.RadioGroup>
              <Menu.Sub>
                <Menu.SubTrigger className="menu-item pdf-submenu-trigger" disabled={!count}>
                  {t('files.zoom')}<span>{scaleLabel}</span><ChevronRight size={14} aria-hidden="true" />
                </Menu.SubTrigger>
                <Menu.Portal>
                  <Menu.SubContent className="menu-surface pdf-menu pdf-submenu" sideOffset={6} collisionPadding={10}>
                    <Menu.Item className="menu-item" onSelect={() => engine.current!.viewer.decreaseScale()}><Minus size={16} aria-hidden="true" />{t('files.zoomOut')}</Menu.Item>
                    <Menu.Item className="menu-item" onSelect={() => engine.current!.viewer.increaseScale()}><Plus size={16} aria-hidden="true" />{t('files.zoomIn')}</Menu.Item>
                    <Menu.Separator className="menu-separator" />
                    <Menu.RadioGroup value={scale} onValueChange={changeScale} aria-label={t('files.zoom')}>
                      {zoomLevels.map(level => <PdfMenuChoice key={level} value={level}>{level}%</PdfMenuChoice>)}
                    </Menu.RadioGroup>
                  </Menu.SubContent>
                </Menu.Portal>
              </Menu.Sub>
              <Menu.Separator className="menu-separator" />
              <Menu.Item className="menu-item" disabled={!count} onSelect={() => setOutlineOpen(value => !value)}>
                <ListTree size={16} aria-hidden="true" />{t(outlineOpen ? 'files.closeOutline' : 'files.outline')}
              </Menu.Item>
              <Menu.Item className="menu-item" disabled={!count} onSelect={startCapture}><Scan size={16} aria-hidden="true" />{t('files.capture')}</Menu.Item>
              <Menu.Sub>
                <Menu.SubTrigger className="menu-item pdf-submenu-trigger">
                  {t('files.pageColors')}<span>{colorLabel}</span><ChevronRight size={14} aria-hidden="true" />
                </Menu.SubTrigger>
                <Menu.Portal>
                  <Menu.SubContent className="menu-surface pdf-menu pdf-submenu" sideOffset={6} collisionPadding={10}>
                    <Menu.RadioGroup value={colorMode} onValueChange={changeColors} aria-label={t('files.pageColors')}>
                      {colorChoices.map(item => <PdfMenuChoice key={item.id} value={item.id}>{item.name}</PdfMenuChoice>)}
                    </Menu.RadioGroup>
                  </Menu.SubContent>
                </Menu.Portal>
              </Menu.Sub>
              <Menu.Separator className="menu-separator" />
              {fileActions}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
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
