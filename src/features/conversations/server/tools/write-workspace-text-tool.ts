import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { writeWorkspaceText } from '@/features/files/server/write-workspace-text';
export function writeWorkspaceTextTool(root: string, id: string, versions: Map<string, string>) {
  return defineTool({ name: 'write_workspace_text', label: '写入文本', description: '创建工作区文本或覆盖已读取的文本。覆盖必须提交 expectedHash；单次最多 2 MiB。', parameters: Type.Object({ path: Type.String({ minLength: 1 }), content: Type.String(), expectedHash: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })) }), executionMode: 'sequential',
    async execute(_callId, args, signal) { const result = await writeWorkspaceText(root, id, args.path, args.content, args.expectedHash, signal); if (versions.has(args.path)) versions.set(args.path, result.hash); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; },
  });
}
