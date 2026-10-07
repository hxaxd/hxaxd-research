import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { editWorkspaceText } from '@/features/files/server/write-workspace-text';
export function editWorkspaceTextTool(root: string, id: string, versions: Map<string, string>) {
  return defineTool({ name: 'edit_workspace_text', label: '修改文本', description: '替换文本中恰好出现一次的 oldText，必须提交读取时的 expectedHash。', parameters: Type.Object({ path: Type.String({ minLength: 1 }), oldText: Type.String({ minLength: 1 }), newText: Type.String(), expectedHash: Type.String({ pattern: '^[a-f0-9]{64}$' }) }), executionMode: 'sequential',
    async execute(_callId, args, signal) { const result = await editWorkspaceText(root, id, args.path, args.oldText, args.newText, args.expectedHash, signal); if (versions.has(args.path)) versions.set(args.path, result.hash); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; },
  });
}
