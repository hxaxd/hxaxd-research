'use client';

import { useTranslations } from 'use-intl';

import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { defaultUrlTransform } from 'react-markdown';

import { requestJson } from '@/shared/http/request-json';
import { Markdown } from '@/shared/ui/Markdown';

import { textFileSchema } from '../schema';

export function TextPreview({ url, markdown, onOpenFile }: { url: string; markdown?: { workspaceId: string; path: string }; onOpenFile?: (path: string) => void }) {
  const t = useTranslations();
  const [file, setFile] = useState<z.infer<typeof textFileSchema> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void requestJson<z.infer<typeof textFileSchema>>(`${url}&format=text`, {
      signal: controller.signal,
    })
      .then(setFile)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [url]);
  if (error)
    return (
      <p role="alert" className="error-message">
        {error}
      </p>
    );
  if (!file) return <p className="empty-small">{t('files.textLoading')}</p>;
  const previewRoot = markdown ? `/api/workspaces/${markdown.workspaceId}/preview/` : '';
  const base = markdown ? `http://workspace.local${previewRoot}${markdown.path.split('/').map(encodeURIComponent).join('/')}` : '';
  return (
    <div className={markdown ? 'document-markdown markdown' : 'text-preview'}>
      {file.truncated && <p className="preview-notice">{t('files.truncated')}</p>}
      {markdown ? (
        <Markdown
          urlTransform={(url) => {
            const safe = defaultUrlTransform(url);
            if (!safe || /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(safe)) return safe;
            const target = new URL(safe, base);
            return `${target.pathname}${target.search}${target.hash}`;
          }}
          components={{ a: ({ href, children }) => (
            <a href={href} onClick={event => {
              if (href?.startsWith(previewRoot) && onOpenFile) {
                event.preventDefault();
                onOpenFile(decodeURIComponent(new URL(href, base).pathname.slice(previewRoot.length)));
              }
            }} target={href?.startsWith('http') ? '_blank' : undefined} rel="noreferrer">{children}</a>
          ) }}
        >{file.text}</Markdown>
      ) : <pre>{file.text}</pre>}
    </div>
  );
}
