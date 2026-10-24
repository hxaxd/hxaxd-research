import 'server-only';

import type { AgentSession } from '@earendil-works/pi-coding-agent';

import type { ModelProviders } from '@/features/models/server/providers';
import type { AppConfig } from '@/server/config';
import type { ReaderController } from '@/features/files/server/reader';
import { ApiError, isApiError } from '@/shared/http/api-error';

import type { Conversation, ConversationRun, ConversationSnapshot, SendMessage } from '../schema';
import { getConversation, renameConversation } from './conversations';
import { readConversationHistory } from './history';
import { mapPiEvent } from './pi-events';
import { buildReadingContext } from './reading-context';
import { createPiSession, type ModelSelection } from './session';

type LiveConversation = {
  snapshot: ConversationSnapshot;
  listeners: Set<(snapshot: ConversationSnapshot) => void>;
  session?: AgentSession;
  execution?: Promise<void>;
  controller?: AbortController;
  request?: string;
};

export class PiSessionRegistry {
  private readonly conversations = new Map<string, LiveConversation>();

  constructor(
    private readonly config: AppConfig,
    private readonly providers: ModelProviders,
    private readonly reader: ReaderController,
  ) {}

  private async resolveModel(id: string, signal: AbortSignal): Promise<ModelSelection> {
    const { runtime, models } = await this.providers.available(
      id.slice(0, id.indexOf('/')),
      signal,
    );
    const model = models.find((model) => `${model.provider}/${model.id}` === id);
    if (!model)
      throw new ApiError(503, 'model_unavailable', '模型不可用，请在模型供应商中连接并刷新模型');
    return { runtime, model };
  }

  private record(workspaceId: string, id: string) {
    const key = `${workspaceId}/${id}`;
    let record = this.conversations.get(key);
    if (!record) {
      record = {
        snapshot: {
          revision: 0,
          messages: readConversationHistory(this.config.workspaceDir, workspaceId, id),
          run: null,
          error: null,
        },
        listeners: new Set(),
      };
      this.conversations.set(key, record);
    } else if (!record.execution) {
      record.snapshot = {
        ...record.snapshot,
        messages: readConversationHistory(this.config.workspaceDir, workspaceId, id),
      };
    }
    return record;
  }

  snapshot(workspaceId: string, id: string) {
    return this.record(workspaceId, id).snapshot;
  }

  subscribe(workspaceId: string, id: string, listener: (snapshot: ConversationSnapshot) => void) {
    const record = this.record(workspaceId, id);
    record.listeners.add(listener);
    listener(record.snapshot);
    return () => {
      record.listeners.delete(listener);
      this.release(record);
    };
  }

  private emit(record: LiveConversation) {
    record.snapshot = { ...record.snapshot, revision: record.snapshot.revision + 1 };
    for (const listener of record.listeners) listener(record.snapshot);
  }

  private release(record: LiveConversation) {
    if (!record.execution && !record.listeners.size) {
      record.session?.dispose();
      record.session = undefined;
    }
  }

  private async sessionFor(record: LiveConversation, conversation: Conversation, input: SendMessage, signal: AbortSignal) {
    const selection = await this.resolveModel(input.model, signal);
    if (input.clips?.length && !selection.model.input.includes('image'))
      throw new ApiError(400, 'image_not_supported', '当前模型不支持图片，请切换支持图片的模型');
    const session = record.session ?? (await createPiSession(
      this.config, selection, conversation.workspaceId, conversation.id, this.reader,
    ));
    record.session = session;
    await session.setModel(selection.model);
    signal.throwIfAborted();
    return session;
  }

  async send(workspaceId: string, id: string, input: SendMessage) {
    const root = this.config.workspaceDir;
    const conversation = getConversation(root, workspaceId, id);
    const context = await buildReadingContext(root, workspaceId, input.reading, input.clips, input.quotes);
    return this.start(conversation, input, context);
  }

  private start(conversation: Conversation, input: SendMessage, context: string | null) {
    const { workspaceId, id } = conversation;
    const record = this.record(workspaceId, id);
    const request = JSON.stringify(input);
    if (record.snapshot.run?.id === input.id) {
      if (record.request !== request)
        throw new ApiError(409, 'conflict', '该请求 ID 已用于其他内容');
      return record.snapshot.run;
    }
    if (record.execution) throw new ApiError(409, 'busy', '当前对话正在回答，请等待或停止');
    const run: ConversationRun = {
      id: input.id,
      conversationId: id,
      status: 'accepted',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      errorCode: null,
    };
    record.request = request;
    record.snapshot = { ...record.snapshot, run, error: null };
    record.controller = new AbortController();
    const signal = record.controller.signal;
    this.emit(record);
    record.execution = (async () => {
      let unsubscribe: (() => void) | undefined;
      try {
        const session = await this.sessionFor(record, conversation, input, signal);
        let liveId = '';
        let sequence = 0;
        unsubscribe = session.subscribe((event) => {
          if (event.type === 'message_start') liveId = `live:${run.id}:${sequence++}`;
          record.snapshot = {
            ...record.snapshot,
            messages: mapPiEvent(event, record.snapshot.messages, liveId, `/api/workspaces/${workspaceId}/conversations/${id}/images`, input.quotes),
          };
          this.emit(record);
        });
        run.status = 'running';
        this.emit(record);
        if (context) await session.sendCustomMessage({
          customType: 'reading-context', content: context, display: false,
          details: { quotes: input.quotes ?? [] },
        });
        await session.prompt(input.text, {
          expandPromptTemplates: false,
          images: input.clips?.map(({ data }) => ({ type: 'image', mimeType: 'image/png', data })),
        });
        const last = session.messages.findLast((message) => message.role === 'assistant');
        if (last?.stopReason === 'error')
          throw new ApiError(502, 'model_failed', last.errorMessage || '模型调用失败');
        run.status = signal.aborted ? 'cancelled' : 'completed';
      } catch (error) {
        run.status = signal.aborted ? 'cancelled' : 'failed';
        run.errorCode = signal.aborted
          ? null
          : isApiError(error)
            ? error.code
            : 'execution_failed';
        record.snapshot.error = signal.aborted
          ? null
          : error instanceof Error
            ? error.message
            : '对话执行失败';
        if (!signal.aborted) console.error('Pi run failed', run.id, error);
      } finally {
        unsubscribe?.();
        run.finishedAt = new Date().toISOString();
        record.execution = undefined;
        record.controller = undefined;
        record.snapshot = {
          ...record.snapshot,
          messages: readConversationHistory(this.config.workspaceDir, workspaceId, id),
        };
        this.emit(record);
        this.release(record);
      }
    })();
    void record.execution.catch((error) => {
      console.error('Pi cleanup failed', run.id, error);
      record.execution = undefined;
      record.snapshot.error = '对话历史读取失败，请检查会话文件';
      this.emit(record);
      this.release(record);
    });
    return run;
  }

  rename(workspaceId: string, id: string, name: string) {
    const manager = this.conversations.get(`${workspaceId}/${id}`)?.session?.sessionManager;
    return renameConversation(this.config.workspaceDir, workspaceId, id, name, manager);
  }

  async stop(workspaceId: string, id: string, runId: string) {
    getConversation(this.config.workspaceDir, workspaceId, id);
    const record = this.conversations.get(`${workspaceId}/${id}`);
    if (record?.snapshot.run?.id === runId && record.execution) {
      record.controller?.abort();
      if (record.session) await record.session.abort();
      await record.execution;
    }
    return record?.snapshot.run ?? null;
  }
}
