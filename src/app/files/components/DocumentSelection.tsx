'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { QuoteSelectionActions } from '@/app/conversations/components/QuoteSelectionActions';
import type { ReadingContext, TextQuote } from '../schema';

export function DocumentSelection({ reading, onQuote, children }: {
  reading: ReadingContext;
  onQuote: (quote: TextQuote) => Promise<void>;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const nativeSelection = useRef<Selection | null>(null);
  const [quote, setQuote] = useState<TextQuote | null>(null);
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
      };
      doc.addEventListener('selectionchange', update);
      doc.addEventListener('pointerup', update);
      return () => {
        doc.removeEventListener('selectionchange', update);
        doc.removeEventListener('pointerup', update);
      };
    }
    const unbind = observe(document, element);
    function loaded(event?: Event) {
      const frame = element.querySelector('iframe');
      if (event && event.target !== frame) return;
      unbindFrame?.();
      unbindFrame = undefined;
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
    element.addEventListener('load', loaded, true);
    loaded();
    return () => { unbind(); unbindFrame?.(); element.removeEventListener('load', loaded, true); };
  }, [path, mode]);

  return <div className="resource-body" ref={root}>
    {children}
    {quote && <QuoteSelectionActions key={quote.text} text={quote.text} onClear={() => setQuote(null)}
      onAttach={async () => { await onQuote(quote); nativeSelection.current?.removeAllRanges(); setQuote(null); }} />}
  </div>;
}
