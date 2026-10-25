'use client';

import { useTranslations } from 'use-intl';

import { Check, RotateCcw, X } from 'lucide-react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

import type { ImageClip } from '../schema';

type Point = { x: number; y: number };
type Selection = {
  page: number;
  bounds: { left: number; top: number; width: number; height: number };
  from: Point;
  to: Point;
};

function region(selection: Selection) {
  return {
    x: Math.min(selection.from.x, selection.to.x),
    y: Math.min(selection.from.y, selection.to.y),
    width: Math.abs(selection.from.x - selection.to.x),
    height: Math.abs(selection.from.y - selection.to.y),
  };
}

function hasArea(selection: Selection) {
  const box = region(selection);
  return box.width * selection.bounds.width >= 8 && box.height * selection.bounds.height >= 8;
}

export function PdfRegionSelection({ getPage, scroll, onCapture, onClose }: {
  getPage: (page: number) => ReturnType<PDFDocumentProxy['getPage']>;
  scroll: RefObject<HTMLDivElement | null>;
  onCapture: (clip: Omit<ImageClip, 'path'>) => Promise<void>;
  onClose: () => void;
}) {
  const t = useTranslations();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const drag = useRef<{ id: number; selection: Selection } | null>(null);
  const render = useRef<RenderTask | null>(null);
  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => { disposed.current = true; render.current?.cancel(); };
  }, []);

  function position(event: PointerEvent<HTMLDivElement>, bounds: Selection['bounds']): Point {
    const overlay = event.currentTarget.getBoundingClientRect();
    const scale = overlay.width / event.currentTarget.offsetWidth;
    return {
      x: Math.max(0, Math.min(1, ((event.clientX - overlay.left) / scale - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, ((event.clientY - overlay.top) / scale - bounds.top) / bounds.height)),
    };
  }

  async function capture() {
    setBusy(true);
    setError('');
    try {
      const box = region(selection!);
      const page = await getPage(selection!.page);
      if (disposed.current) return;
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(3, 2048 / Math.max(box.width * original.width, box.height * original.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(box.width * viewport.width);
      canvas.height = Math.ceil(box.height * viewport.height);
      render.current = page.render({
        canvas,
        viewport,
        transform: [1, 0, 0, 1, -box.x * viewport.width, -box.y * viewport.height],
        background: '#fff',
      });
      await render.current.promise;
      if (disposed.current) return;
      await onCapture({ page: selection!.page, data: canvas.toDataURL('image/png').split(',')[1] });
      onClose();
    } catch (error) {
      if (!disposed.current) setError((error as Error).message);
    } finally {
      render.current = null;
      if (!disposed.current) setBusy(false);
    }
  }

  const box = selection && region(selection);
  return (
    <>
      <div className="pdf-selection-overlay" aria-label={t('files.pdfRegion')}
        onPointerDown={event => {
          if (busy || !event.isPrimary || event.button !== 0) return;
          const page = Array.from(scroll.current!.querySelectorAll<HTMLElement>('.page')).find(element => {
            const rect = element.getBoundingClientRect();
            return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
          });
          if (!page) return;
          const rect = page.getBoundingClientRect();
          const overlay = event.currentTarget.getBoundingClientRect();
          const scale = overlay.width / event.currentTarget.offsetWidth;
          const bounds = { left: (rect.left - overlay.left) / scale, top: (rect.top - overlay.top) / scale, width: rect.width / scale, height: rect.height / scale };
          const point = position(event, bounds);
          const pageNumber = Number(page.dataset.pageNumber);
          const next = selection && !hasArea(selection) && selection.page === pageNumber
            ? { ...selection, to: point }
            : { page: pageNumber, bounds, from: point, to: point };
          drag.current = { id: event.pointerId, selection: next };
          event.currentTarget.setPointerCapture(event.pointerId);
          setSelection(next);
          setError('');
        }}
        onPointerMove={event => {
          if (drag.current?.id !== event.pointerId) return;
          const next = { ...drag.current.selection, to: position(event, drag.current.selection.bounds) };
          drag.current.selection = next;
          setSelection(next);
        }}
        onPointerUp={event => {
          if (drag.current?.id !== event.pointerId) return;
          setSelection({ ...drag.current.selection, to: position(event, drag.current.selection.bounds) });
          drag.current = null;
        }}
        onPointerCancel={() => { drag.current = null; setSelection(null); }}
      >
        {selection && box && (
          <div className={`pdf-selection-box${hasArea(selection) ? '' : ' anchor'}`} style={{
            left: selection.bounds.left + box.x * selection.bounds.width,
            top: selection.bounds.top + box.y * selection.bounds.height,
            width: box.width * selection.bounds.width,
            height: box.height * selection.bounds.height,
          }} />
        )}
      </div>
      <div className="pdf-selection-actions" role="group" aria-label={t('files.regionActions')}>
        <span role="status">{error || (busy ? t('files.capturing') : selection && hasArea(selection) ? t('files.pageNumber', {value0: selection.page}) : t('files.regionHint'))}</span>
        <div>
          {selection && <button className="button secondary" disabled={busy} onClick={() => setSelection(null)}><RotateCcw size={16} aria-hidden="true" />{t('files.reselect')}</button>}
          <button className="button secondary" autoFocus disabled={busy} onClick={onClose}><X size={16} aria-hidden="true" />{t('common.cancel')}</button>
          <button className="button" disabled={busy || !selection || !hasArea(selection)} onClick={() => void capture()}><Check size={16} aria-hidden="true" />{t('files.attach')}</button>
        </div>
      </div>
    </>
  );
}
