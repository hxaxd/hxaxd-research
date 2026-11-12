'use client';

import renderMathInElement from 'katex/contrib/auto-render';
import { Play, Square } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

import { useAppearance } from '@/app/settings/components/use-appearance';
import type { ReadingContext } from '../schema';
import { resolveWorkspaceLink } from '../workspace-link';
import { ReaderToolbar } from './ReaderToolbar';

export function HtmlPreview({ url, workspaceId, onOpenDocument }: {
  url: string;
  workspaceId: string;
  onOpenDocument: (target: ReadingContext) => void;
}) {
  const t = useTranslations();
  const { resolvedMode } = useAppearance();
  const frame = useRef<HTMLIFrameElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [interactive, setInteractive] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const setPaperTheme = useEffectEvent((doc: Document | null | undefined) => {
    const root = doc?.documentElement;
    if (root?.hasAttribute('data-workbench-paper')) root.dataset.theme = resolvedMode;
  });
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => setPaperTheme(frame.current?.contentDocument), [resolvedMode]);

  useEffect(() => {
    const element = frame.current!;
    let doc: Document | null = null;
    function clicked(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
      if (!link || link.hasAttribute('download')) return;
      if (link.getAttribute('href')!.trim().startsWith('#')) {
        if (doc?.documentElement.hasAttribute('data-workbench-paper')) link.closest('details.contents')?.removeAttribute('open');
        return;
      }
      if (new URL(link.href).searchParams.has('download')) return;
      const target = resolveWorkspaceLink(link.href, workspaceId, window.location.origin);
      if (!target) return;
      event.preventDefault();
      onOpenDocument(target);
    }
    function loaded() {
      doc?.removeEventListener('click', clicked);
      // A link may navigate the frame to another origin.
      doc = element.contentDocument;
      doc?.addEventListener('click', clicked);
      setPaperTheme(doc);
      const paper = interactive === null ? doc?.querySelector<HTMLElement>('[data-workbench-paper] article') : null;
      if (paper && !paper.dataset.mathRendered) {
        renderMathInElement(paper, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
            { left: '$', right: '$', display: false },
          ],
          throwOnError: false,
        });
        paper.dataset.mathRendered = 'true';
      }
    }
    element.addEventListener('load', loaded);
    loaded();
    return () => {
      element.removeEventListener('load', loaded);
      doc?.removeEventListener('click', clicked);
    };
  }, [url, workspaceId, onOpenDocument, interactive]);

  async function runScripts() {
    if (!window.confirm(t('files.trustHtml'))) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError(false);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error();
      const source = await response.text();
      if (controller.signal.aborted) return;
      // srcdoc needs the preview URL to resolve the document's relative assets.
      const doc = new DOMParser().parseFromString(source, 'text/html');
      const previewUrl = new URL(url, window.location.href);
      const base = doc.head.querySelector<HTMLBaseElement>('base[href]') ?? doc.createElement('base');
      base.href = new URL(base.getAttribute('href') ?? '', previewUrl).href;
      if (!base.isConnected) doc.head.prepend(base);
      const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : '';
      setInteractive(doctype + doc.documentElement.outerHTML);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  const label = t(interactive === null ? 'files.runHtml' : 'files.stopHtml');
  return <>
    <ReaderToolbar>
      <button type="button" className="icon-button" title={label} aria-label={label} disabled={loading}
        onClick={() => interactive === null ? void runScripts() : setInteractive(null)}>
        {interactive === null ? <Play size={16} aria-hidden="true" /> : <Square size={16} aria-hidden="true" />}
      </button>
    </ReaderToolbar>
    {error && <p role="alert" className="error-message">{t('files.htmlRunFailed')}</p>}
    <iframe ref={frame} key={interactive === null ? 'preview' : 'interactive'} className="html-preview" title={t('files.htmlPreview')}
      src={interactive === null ? url : undefined} srcDoc={interactive ?? undefined}
      sandbox={interactive === null ? 'allow-same-origin' : 'allow-same-origin allow-scripts allow-forms allow-downloads allow-popups'}
      allowFullScreen referrerPolicy="no-referrer" />
  </>;
}
