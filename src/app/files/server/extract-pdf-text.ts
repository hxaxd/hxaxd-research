import 'server-only';
import { text as t } from '@/app/i18n/server.mjs';

import { readFile, stat } from 'node:fs/promises';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import type { AppConfig } from '@/app/config.mjs';
import { ApiError } from '@/shared/http/api-error';

export async function extractPdfText(
  file: string,
  startPage: number,
  endPage: number,
  limits: AppConfig['files'],
  signal?: AbortSignal,
) {
  if ((await stat(file)).size > limits.pdfBytes)
    throw new ApiError(413, 'too_large', t('errors.pdfSize'));
  const bytes = await readFile(file);
  signal?.throwIfAborted();
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    if (
      startPage < 1 ||
      startPage > pdf.numPages ||
      endPage < startPage ||
      endPage - startPage >= limits.pdfPages
    )
      throw new ApiError(400, 'invalid_pages', t('errors.pdfPages', {value0: limits.pdfPages}));
    const pages: { page: number; text: string }[] = [];
    for (let page = startPage; page <= Math.min(endPage, pdf.numPages); page++) {
      signal?.throwIfAborted();
      const content = await (await pdf.getPage(page)).getTextContent();
      pages.push({
        page,
        text: content.items
          .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
          .join('')
          .slice(0, limits.pdfPageCharacters),
      });
    }
    return {
      path: file,
      totalPages: pdf.numPages,
      pages,
      notice: pages.every((page) => !page.text.trim())
        ? t('files.noText')
        : null,
    };
  } finally {
    await task.destroy();
  }
}
