import 'server-only';
import path from 'node:path';

import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { getWorkspaceContext } from '@/features/workspaces/server/workspaces';
import { translationContext } from '@/features/translation/runtime';

export function workspaceContextTool(root: string, workspaceId: string) {
  return defineTool({
    name: 'get_workspace_context',
    label: '查看工作区',
    description:
      '读取当前工作区名称、论文名称与实际相对目录、项目 TeX 环境，以及翻译、OCR 和已注册模型的调用入口。文件内容请用文件工具读取。',
    parameters: Type.Object({}),
    async execute(_callId, _args, signal) {
      signal?.throwIfAborted();
      const texRoot = path.resolve('.runtime/env/tex');
      const result = {
        ...getWorkspaceContext(root, workspaceId),
        translation: translationContext(path.dirname(root)),
        tex: {
          root: texRoot,
          executable: path.join(texRoot, process.platform === 'win32' ? 'tectonic.exe' : 'tectonic'),
          fonts: path.join(texRoot, 'fonts'),
        },
      };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}
