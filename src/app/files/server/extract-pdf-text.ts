import 'server-only';

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
    throw new ApiError(413, 'too_large', 'PDF 超过读取上限');
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
      throw new ApiError(400, 'invalid_pages', `每次读取 1 至 ${limits.pdfPages} 页，请使用有效页码`);
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
        ? '这些页面没有可提取文字；扫描材料需要 OCR。'
        : null,
    };
  } finally {
    await task.destroy();
  }
}
