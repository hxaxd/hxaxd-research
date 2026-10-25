import 'server-only';
import path from 'node:path';
import type { AppConfig } from '@/app/config.mjs';

import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { getWorkspaceContext } from '@/app/workspaces/workspaces';
import { translationContext } from '@/app/translation/runtime';

export function workspaceContextTool(config: AppConfig, workspaceId: string) {
  return defineTool({
    name: 'get_workspace_context',
    label: '查看工作区',
    description:
      '读取当前工作区信息、应用配置路径、项目 TeX 环境，以及翻译、OCR 和已注册模型的调用入口。文件内容请用文件工具读取。',
    parameters: Type.Object({}),
    async execute(_callId, _args, signal) {
      signal?.throwIfAborted();
      const texRoot = config.texDir;
      const result = {
        projectRoot: process.cwd(),
        ...getWorkspaceContext(config.workspaceDir, workspaceId),
        configuration: {
          application: config.configFile,
          models: path.join(config.piDir, 'models.json'),
          speech: path.join(config.dataDir, 'speech.json'),
          templates: config.templateDir,
          inspectCommand: [process.execPath, path.resolve('src/app/config.mjs')],
        },
        translation: translationContext(config),
        tex: {
          root: texRoot,
          executable: path.join(texRoot, process.platform === 'win32' ? 'tectonic.exe' : 'tectonic'),
          fonts: path.join(texRoot, 'fonts'),
          setupCommand: [process.execPath, path.resolve('src/app/latex/setup.mjs')],
        },
      };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}
