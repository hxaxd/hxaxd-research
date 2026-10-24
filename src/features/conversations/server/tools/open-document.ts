import 'server-only';

import { stat } from 'node:fs/promises';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { resolveWorkspacePath } from '@/features/files/server/paths';
import type { ReaderController } from '@/features/files/server/reader';
import { ApiError } from '@/shared/http/api-error';

export function openDocumentTool(root: string, workspaceId: string, conversationId: string, reader: ReaderController) {
  return defineTool({
    name: 'open_document',
    label: '打开阅读材料',
    description: '请求当前对话的中间阅读区显示一个已存在的工作区文件。path 是相对路径，不接受网页 URL；不会生成、编译或检查页面运行结果。Markdown／HTML 可选择源码或预览，HTML 预览执行页面脚本；PDF 可指定页码。HTML 运行边界见 document-workbench 技能。',
    parameters: Type.Object({
      path: Type.String(),
      mode: Type.Optional(Type.Union([Type.Literal('source'), Type.Literal('preview')])),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(callId, args, signal) {
      signal?.throwIfAborted();
      const relative = args.path.replaceAll('\\', '/');
      const file = await resolveWorkspacePath(root, workspaceId, relative);
      if (!(await stat(file)).isFile()) throw new ApiError(400, 'invalid_file', '请选择要打开的文件');
      const result = { ...args, path: relative };
      reader.open(workspaceId, { ...result, id: callId, conversationId });
      return { content: [{ type: 'text', text: `已请求在阅读区打开 ${relative}` }], details: result };
    },
  });
}
