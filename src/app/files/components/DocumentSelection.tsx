'use client';

import { useTranslations } from 'use-intl';

import { Quote, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { ReadingContext, TextQuote } from '../schema';

export function DocumentSelection({ reading, onQuote, children }: {
  reading: ReadingContext;
  onQuote: (quote: TextQuote) => Promise<void>;
  children: ReactNode;
}) {
  const t = useTranslations();
  const root = useRef<HTMLDivElement>(null);
  const nativeSelection = useRef<Selection | null>(null);
  const [quote, setQuote] = useState<TextQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { path, mode } = reading;
  useEffect(() => {
    const element = root.current!;
    let unbindFrame: (() => void) | undefined;
    let selectedDocument: Document | undefined;
    function observe(doc: Document, content: HTMLElement) {
      const update = () => {
        const selection = doc.getSelection();
        if (!selection?.rangeCount || !content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) {
          if (selectedDocument === doc) setQuote(null);
          return;
        }
        const node = selection.getRangeAt(0).startContainer;
        const parent = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
        if (parent?.closest('button, input, textarea, select, .pdf-toolbar, .selection-actions')) return;
        const text = selection.toString().trim();
        nativeSelection.current = selection;
        selectedDocument = doc;
        const page = parent?.closest<HTMLElement>('.page[data-page-number]')?.dataset.pageNumber;
        setQuote(text ? { path, ...(mode ? { mode } : {}), ...(page ? { page: Number(page) } : {}), text } : null);
        setError(text.length > 10000 ? t('errors.quoteLength') : '');
      };
      doc.addEventListener('selectionchange', update);
      doc.addEventListener('pointerup', update);
      return () => {
        doc.removeEventListener('selectionchange', update);
        doc.removeEventListener('pointerup', update);
      };
    }
    const unbind = observe(document, element);
    const frame = element.querySelector('iframe');
    function loaded() {
      unbindFrame?.();
      selectedDocument = undefined;
      setQuote(null);
      // Only the same-origin workspace document is accessible after navigation.
      try {
        const doc = frame?.contentDocument;
        if (doc?.body) unbindFrame = observe(doc, doc.body);
      } catch {
        unbindFrame = undefined;
      }
    }
    frame?.addEventListener('load', loaded);
    loaded();
    return () => { unbind(); unbindFrame?.(); frame?.removeEventListener('load', loaded); };
  }, [path, mode, t]);

  return <div className="resource-body" ref={root}>
    {children}
    {quote && <div className="selection-actions" role="group" aria-label={t('files.selection')}>
      <span title={quote.text}>{error || quote.text}</span>
      <button className="button" disabled={busy || quote.text.length > 10000}
        onPointerDown={event => event.preventDefault()} onClick={async () => {
          setBusy(true);
          setError('');
          try { await onQuote(quote); nativeSelection.current?.removeAllRanges(); setQuote(null); }
          catch (error) { setError((error as Error).message); }
          finally { setBusy(false); }
        }}><Quote size={16} aria-hidden="true" />{busy ? t('files.attaching') : t('files.quote')}</button>
      <button className="icon-button" aria-label={t('files.cancelQuote')} onClick={() => setQuote(null)}><X size={17} /></button>
    </div>}
  </div>;
}
