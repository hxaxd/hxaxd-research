import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { listWorkspaceFiles } from '@/features/files/server/list-workspace-files';
export function listWorkspaceFilesTool(root: string, id: string) {
  return defineTool({ name: 'list_workspace_files', label: '浏览材料', description: '列出工作区相对目录中的文件与子目录。空路径代表工作区根目录。', parameters: Type.Object({ path: Type.String() }),
    async execute(_callId, args, signal) { signal?.throwIfAborted(); const result = await listWorkspaceFiles(root, id, args.path); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; },
  });
}
