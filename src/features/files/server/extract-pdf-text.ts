import 'server-only';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { resolveWorkspacePath } from './resolve-workspace-path';
import { ApiError } from '@/shared/http/api-error';
export async function extractPdfText(workspaceDir: string, workspaceId: string, relative: string, startPage = 1, endPage = startPage + 4, signal?: AbortSignal) {
  const file = await resolveWorkspacePath(workspaceDir, workspaceId, relative);
  if ((await stat(file)).size > 256 * 1024 * 1024) throw new ApiError(413, 'too_large', 'PDF 超过读取上限');
  const bytes = await readFile(file);
  signal?.throwIfAborted();
  const hash = createHash('sha256').update(bytes).digest('hex');
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    if (startPage < 1 || startPage > pdf.numPages || endPage < startPage || endPage - startPage >= 20) throw new ApiError(400, 'invalid_pages', '每次读取 1 至 20 页，请使用有效页码');
    const pages: { page: number; text: string }[] = [];
    for (let page = startPage; page <= Math.min(endPage, pdf.numPages); page++) {
      signal?.throwIfAborted();
      const content = await (await pdf.getPage(page)).getTextContent();
      pages.push({ page, text: content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').slice(0, 60000) });
    }
    return { path: relative, hash, totalPages: pdf.numPages, pages, notice: pages.every(page => !page.text.trim()) ? '这些页面没有可提取文字；扫描材料需要 OCR。' : null };
  } finally { await task.destroy(); }
}
