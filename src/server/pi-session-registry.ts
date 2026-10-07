import 'server-only';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { ModelRuntime, type AgentSession } from '@earendil-works/pi-coding-agent';
import type { AppConfig } from './read-app-config';
import type { ConfiguredModel, ConversationSnapshot, ConversationRun } from '@/features/conversations/conversation-schema';
import { getConversation, saveSessionFile } from '@/features/conversations/server/conversation-store';
import { getRun, latestRun, startRun, finishRun } from '@/features/conversations/server/conversation-run-store';
import { createPiSession } from '@/features/conversations/server/create-pi-session';
import { readConversationHistory } from '@/features/conversations/server/read-conversation-history';
import { mapPiEvent } from '@/features/conversations/server/map-pi-event';
import { ApiError } from '@/shared/http/api-error';
type LiveConversation = {
  workspaceId: string; snapshot: ConversationSnapshot; listeners: Set<(snapshot: ConversationSnapshot) => void>;
  session?: AgentSession; sessionPromise?: Promise<AgentSession>; execution?: Promise<void>; controller?: AbortController;
  versions: Map<string, string>;
};
export class PiSessionRegistry {
  private readonly conversations = new Map<string, LiveConversation>();
  private modelRuntime?: Promise<ModelRuntime>;
  constructor(private readonly db: Database.Database, private readonly config: AppConfig) {}
  getModelsRuntime() {
    this.modelRuntime ??= ModelRuntime.create({ authPath: path.join(this.config.piDir, 'auth.json'), modelsPath: path.join(this.config.piDir, 'models.json') });
    return this.modelRuntime;
  }
  async models(): Promise<ConfiguredModel[]> {
    const runtime = await this.getModelsRuntime();
    const models = await runtime.getAvailable();
    if (runtime.getError()) throw new ApiError(503, 'model_config_invalid', runtime.getError()!);
    return models.map(model => ({ id: `${model.provider}/${model.id}`, name: model.name, provider: model.provider }));
  }
  private record(workspaceId: string, id: string) {
    getConversation(this.db, workspaceId, id);
    let record = this.conversations.get(id);
    if (!record) {
      record = { workspaceId, snapshot: { revision: 0, messages: readConversationHistory(this.db, this.config, workspaceId, id), run: latestRun(this.db, id), error: null }, listeners: new Set(), versions: new Map() };
      this.conversations.set(id, record);
    }
    return record;
  }
  snapshot(workspaceId: string, id: string) { return this.record(workspaceId, id).snapshot; }
  subscribe(workspaceId: string, id: string, listener: (snapshot: ConversationSnapshot) => void) {
    const record = this.record(workspaceId, id);
    record.listeners.add(listener);
    listener(record.snapshot);
    return () => { record.listeners.delete(listener); this.release(id, record); };
  }
  private emit(record: LiveConversation) {
    record.snapshot = { ...record.snapshot, revision: record.snapshot.revision + 1 };
    for (const listener of record.listeners) listener(record.snapshot);
  }
  private release(id: string, record: LiveConversation) {
    if (!record.execution && !record.listeners.size) { record.session?.dispose(); this.conversations.delete(id); }
  }
  start(workspaceId: string, id: string, run: ConversationRun, modelId: string, prompt: string, versions: Map<string, string>) {
    const record = this.record(workspaceId, id);
    record.snapshot = { ...record.snapshot, run, error: null };
    record.controller = new AbortController();
    record.versions.clear();
    for (const [file, hash] of versions) record.versions.set(file, hash);
    const signal = record.controller.signal;
    this.emit(record);
    record.execution = (async () => {
      let unsubscribe: (() => void) | undefined;
      try {
        const runtime = await this.getModelsRuntime();
        record.sessionPromise ??= createPiSession(this.db, this.config, runtime, workspaceId, id, modelId, record.versions);
        const session = await record.sessionPromise;
        record.session = session;
        const model = runtime.getAvailableSnapshot().find(model => `${model.provider}/${model.id}` === modelId);
        if (!model) throw new ApiError(503, 'model_unavailable', '所选模型未配置');
        await session.setModel(model);
        signal.throwIfAborted();
        let liveId = '';
        let sequence = 0;
        unsubscribe = session.subscribe(event => {
          if (event.type === 'message_start') liveId = `live:${run.id}:${sequence++}`;
          record.snapshot = { ...record.snapshot, messages: mapPiEvent(event, record.snapshot.messages, liveId) };
          this.emit(record);
          if (session.sessionFile && existsSync(session.sessionFile)) saveSessionFile(this.db, id, session.sessionFile);
        });
        startRun(this.db, run.id); record.snapshot.run = getRun(this.db, run.id); this.emit(record);
        await session.prompt(prompt, { expandPromptTemplates: false });
        const last = session.messages.findLast(message => message.role === 'assistant');
        if (last && last.role === 'assistant' && last.stopReason === 'error') throw new ApiError(502, 'model_failed', last.errorMessage || '模型调用失败');
        finishRun(this.db, run.id, signal.aborted ? 'cancelled' : 'completed');
      } catch (error) {
        finishRun(this.db, run.id, signal.aborted ? 'cancelled' : 'failed', signal.aborted ? null : error instanceof ApiError ? error.code : 'execution_failed');
        record.snapshot.error = signal.aborted ? null : error instanceof Error ? error.message : '对话执行失败';
        if (!signal.aborted) console.error('Pi run failed', run.id, error);
      } finally {
        unsubscribe?.();
        if (record.session?.sessionFile && existsSync(record.session.sessionFile)) saveSessionFile(this.db, id, record.session.sessionFile);
        record.snapshot = { ...record.snapshot, messages: readConversationHistory(this.db, this.config, workspaceId, id), run: getRun(this.db, run.id) };
        record.execution = undefined;
        record.controller = undefined;
        this.emit(record); this.release(id, record);
      }
    })();
    void record.execution.catch(error => { console.error('Pi cleanup failed', run.id, error); record.execution = undefined; record.snapshot.error = '对话历史保存失败，请检查本地文件'; this.emit(record); this.release(id, record); });
  }
  async stop(workspaceId: string, id: string, runId: string) {
    getConversation(this.db, workspaceId, id);
    const record = this.conversations.get(id);
    if (record?.snapshot.run?.id === runId && record.execution) {
      record.controller?.abort();
      if (record.session) await record.session.abort();
      await record.execution;
    }
    return latestRun(this.db, id);
  }
}
