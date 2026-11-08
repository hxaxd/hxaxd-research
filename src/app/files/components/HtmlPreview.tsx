'use client';

import { Play, Square } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useEffect, useRef, useState } from 'react';

import { ReaderToolbar } from './ReaderToolbar';

export function HtmlPreview({ url }: { url: string }) {
  const t = useTranslations();
  const pending = useRef<AbortController | null>(null);
  const [interactive, setInteractive] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => () => pending.current?.abort(), []);

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
    <iframe key={interactive === null ? 'preview' : 'interactive'} className="html-preview" title={t('files.htmlPreview')}
      src={interactive === null ? url : undefined} srcDoc={interactive ?? undefined}
      sandbox={interactive === null ? 'allow-same-origin' : 'allow-same-origin allow-scripts allow-forms allow-downloads allow-popups'}
      allowFullScreen referrerPolicy="no-referrer" />
  </>;
}
