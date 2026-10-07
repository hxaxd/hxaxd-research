import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { extractPdfText } from '@/features/files/server/extract-pdf-text';
import { ApiError } from '@/shared/http/api-error';
export function readPdfPagesTool(root: string, id: string, versions: Map<string, string>) {
  return defineTool({ name: 'read_pdf_pages', label: '读取 PDF', description: '按页提取 PDF 文字。每次最多 20 页，返回实际页码和内容哈希；没有文字的扫描页不进行 OCR。', parameters: Type.Object({ path: Type.String({ minLength: 1 }), startPage: Type.Integer({ minimum: 1 }), endPage: Type.Integer({ minimum: 1 }) }),
    async execute(_callId, args, signal) { const result = await extractPdfText(root, id, args.path, args.startPage, args.endPage, signal); if (versions.has(args.path) && versions.get(args.path) !== result.hash) throw new ApiError(409, 'material_changed', '引用 PDF 已变化，请重新加入对话'); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; },
  });
}
