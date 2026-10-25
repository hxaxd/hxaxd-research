import 'server-only';

import path from 'node:path';

import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { AppConfig } from '@/app/config.mjs';

import { extractPdfText } from '@/app/files/server/extract-pdf-text';

export function readPdfPagesTool(cwd: string, limits: AppConfig['files']) {
  return defineTool({
    name: 'read_pdf_pages',
    label: '读取 PDF',
    description:
      `按页提取 PDF 文字，每次最多 ${limits.pdfPages} 页。接受绝对路径或相对当前工作区的路径；扫描页不进行 OCR。`,
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      startPage: Type.Integer({ minimum: 1 }),
      endPage: Type.Integer({ minimum: 1 }),
    }),
    async execute(_callId, args, signal) {
      const result = await extractPdfText(
        path.resolve(cwd, args.path),
        args.startPage,
        args.endPage,
        limits,
        signal,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}
