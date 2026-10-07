import 'server-only';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AppConfig } from '@/server/read-app-config';
import { resolveWorkspaceRoot } from '@/features/files/server/resolve-workspace-path';
import { getSessionFile } from './conversation-store';
import { createPiResources } from './create-pi-resources';
import { listWorkspaceFilesTool } from './tools/list-workspace-files-tool';
import { readWorkspaceTextTool } from './tools/read-workspace-text-tool';
import { readPdfPagesTool } from './tools/read-pdf-pages-tool';
import { writeWorkspaceTextTool } from './tools/write-workspace-text-tool';
import { editWorkspaceTextTool } from './tools/edit-workspace-text-tool';
export async function createPiSession(db: Database.Database, config: AppConfig, runtime: ModelRuntime, workspaceId: string, conversationId: string, modelId: string, versions: Map<string, string>) {
  const model = runtime.getAvailableSnapshot().find(model => `${model.provider}/${model.id}` === modelId);
  if (!model) throw new Error('所选模型未配置或不可用');
  const cwd = await resolveWorkspaceRoot(config.workspaceDir, workspaceId);
  const directory = path.join(config.piDir, 'sessions', conversationId);
  const file = getSessionFile(db, conversationId);
  const manager = file ? SessionManager.open(file, directory, cwd) : SessionManager.continueRecent(cwd, directory);
  const tools = [listWorkspaceFilesTool(config.workspaceDir, workspaceId), readWorkspaceTextTool(config.workspaceDir, workspaceId, versions), readPdfPagesTool(config.workspaceDir, workspaceId, versions), writeWorkspaceTextTool(config.workspaceDir, workspaceId, versions), editWorkspaceTextTool(config.workspaceDir, workspaceId, versions)];
  return (await createAgentSession({ cwd, agentDir: config.piDir, modelRuntime: runtime, model, sessionManager: manager, settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } }), resourceLoader: createPiResources(cwd, config.piDir), tools: tools.map(tool => tool.name), customTools: tools })).session;
}
