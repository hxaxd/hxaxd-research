import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readWorkspaceText } from '@/features/files/server/read-workspace-file';
import { ApiError } from '@/shared/http/api-error';
export function readWorkspaceTextTool(root: string, id: string, versions: Map<string, string>) {
  return defineTool({ name: 'read_workspace_text', label: '读取文本', description: '按字节偏移读取工作区内的文本，返回内容哈希，修改时必须使用此哈希。', parameters: Type.Object({ path: Type.String({ minLength: 1 }), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 })) }),
    async execute(_callId, args, signal) { signal?.throwIfAborted(); const result = await readWorkspaceText(root, id, args.path, args.offset, args.limit); if (versions.has(args.path) && versions.get(args.path) !== result.hash) throw new ApiError(409, 'material_changed', '引用材料已变化，请重新加入对话'); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; },
  });
}
