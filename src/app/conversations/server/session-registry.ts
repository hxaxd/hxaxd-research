import 'server-only';
import { text as t } from '@/app/i18n/server.mjs';

import { createHash } from 'node:crypto';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

import type { ModelProviders } from '@/app/models/server/providers';
import type { AppConfig } from '@/app/config.mjs';
import type { ReaderController } from '@/app/files/server/reader';
import { readAssistantPrompt } from '@/app/settings/server/assistant-prompt';
import { ApiError, isApiError } from '@/shared/http/api-error';

import type { Conversation, ConversationRun, ConversationSnapshot, SendMessage, UserQuestion } from '../schema';
import { getConversation, renameConversation } from './conversations';
import { readConversationHistory } from './history';
import { mapPiEvent } from './pi-events';
import { buildReadingContext } from './reading-context';
import { createPiSession } from './session';

type LiveConversation = {
  snapshot: ConversationSnapshot;
  listeners: Set<(snapshot: ConversationSnapshot) => void>;
  session?: { agent: AgentSession; additionalPrompt: string };
  execution?: Promise<void>;
  controller?: AbortController;
  requestDigest?: string;
  questions: Map<string, (answer: string | null) => void>;
};

type RecentConversation = Omit<ConversationSnapshot, 'messages'> & { requestDigest?: string };
const recentConversationLimit = 128;

export class PiSessionRegistry {
  private readonly conversations = new Map<string, LiveConversation>();
  private readonly recent = new Map<string, RecentConversation>();

  constructor(
    private readonly config: AppConfig,
    private readonly providers: ModelProviders,
    private readonly reader: ReaderController,
  ) {}

  private record(workspaceId: string, id: string) {
    const key = `${workspaceId}/${id}`;
    let record = this.conversations.get(key);
    if (!record) {
      record = {
        snapshot: this.snapshot(workspaceId, id),
        requestDigest: this.recent.get(key)?.requestDigest,
        listeners: new Set(),
        questions: new Map(),
      };
      this.conversations.set(key, record);
    } else if (!record.execution) {
      record.snapshot = this.snapshot(workspaceId, id);
    }
    return record;
  }

  snapshot(workspaceId: string, id: string) {
    const key = `${workspaceId}/${id}`;
    const record = this.conversations.get(key);
    if (record?.execution) return record.snapshot;
    const latest = record?.snapshot ?? this.recent.get(key);
    return {
      revision: latest?.revision ?? 0,
      run: latest?.run ?? null,
      error: latest?.error ?? null,
      messages: readConversationHistory(this.config.workspaceDir, workspaceId, id),
    };
  }

  subscribe(workspaceId: string, id: string, listener: (snapshot: ConversationSnapshot) => void) {
    const record = this.record(workspaceId, id);
    record.listeners.add(listener);
    listener(record.snapshot);
    return () => {
      record.listeners.delete(listener);
      this.release(`${workspaceId}/${id}`, record);
    };
  }

  private emit(record: LiveConversation) {
    record.snapshot = { ...record.snapshot, revision: record.snapshot.revision + 1 };
    for (const listener of record.listeners) listener(record.snapshot);
  }

  private release(key: string, record: LiveConversation) {
    if (record.execution || record.listeners.size || this.conversations.get(key) !== record) return;
    this.conversations.delete(key);
    record.session?.agent.dispose();
    const { revision, run, error } = record.snapshot;
    if (!run) return;
    this.recent.delete(key);
    this.recent.set(key, { revision, run, error, requestDigest: record.requestDigest });
    if (this.recent.size > recentConversationLimit) {
      const oldest = this.recent.keys().next();
      if (!oldest.done) this.recent.delete(oldest.value);
    }
  }

  private async sessionFor(record: LiveConversation, conversation: Conversation, input: SendMessage, signal: AbortSignal) {
    const selection = await this.providers.resolve(input.model, signal);
    if (input.clips?.length && !selection.model.input.includes('image'))
      throw new ApiError(400, 'image_not_supported', t('models.noImages'));
    const additionalPrompt = readAssistantPrompt(this.config.dataDir);
    if (record.session?.additionalPrompt !== additionalPrompt) {
      const agent = await createPiSession(
        this.config, selection, conversation.workspaceId, conversation.id, this.reader, additionalPrompt,
        (question, signal) => this.ask(record, question, signal),
        record.session?.agent.sessionManager,
      );
      record.session?.agent.dispose();
      record.session = { agent, additionalPrompt };
    }
    const session = record.session.agent;
    await session.setModel(selection.model);
    if (input.thinkingLevel) session.setThinkingLevel(input.thinkingLevel);
    signal.throwIfAborted();
    return session;
  }

  async send(workspaceId: string, id: string, input: SendMessage) {
    const root = this.config.workspaceDir;
    const conversation = getConversation(root, workspaceId, id);
    const key = `${workspaceId}/${id}`;
    const requestDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous = this.existingRun(key, input.id, requestDigest);
    if (previous) return previous;
    let context: string | null;
    try {
      context = await buildReadingContext(root, workspaceId, input.reading, input.clips, input.quotes);
    } catch (error) {
      const existing = this.existingRun(key, input.id, requestDigest);
      if (existing) return existing;
      throw error;
    }
    return this.existingRun(key, input.id, requestDigest) ?? this.start(conversation, input, context, requestDigest);
  }

  private ask(record: LiveConversation, question: UserQuestion, toolSignal?: AbortSignal) {
    const signal = toolSignal ? AbortSignal.any([toolSignal, record.controller!.signal]) : record.controller!.signal;
    if (signal.aborted) return Promise.resolve(null);
    return new Promise<string | null>(resolve => {
      const finish = (answer: string | null) => {
        signal.removeEventListener('abort', cancel);
        record.questions.delete(question.id);
        resolve(answer);
      };
      const cancel = () => finish(null);
      record.questions.set(question.id, finish);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  async answer(workspaceId: string, id: string, questionId: string, answer: string | null) {
    getConversation(this.config.workspaceDir, workspaceId, id);
    const record = this.conversations.get(`${workspaceId}/${id}`);
    const finish = record?.questions.get(questionId);
    if (!finish) throw new ApiError(409, 'question_closed', t('errors.questionClosed'));
    if (answer === null) await this.stop(workspaceId, id, record!.snapshot.run!.id);
    else finish(answer);
    return { accepted: true };
  }

  private existingRun(key: string, requestId: string, requestDigest: string) {
    const active = this.conversations.get(key);
    const previous = this.recent.get(key);
    const previousRun = active ? active.snapshot.run : previous?.run;
    if (active?.execution && previousRun?.id !== requestId)
      throw new ApiError(409, 'busy', t('errors.conversationBusy'));
    if (previousRun?.id === requestId) {
      const previousDigest = active ? active.requestDigest : previous?.requestDigest;
      if (previousDigest !== requestDigest)
        throw new ApiError(409, 'conflict', t('errors.requestConflict'));
      return previousRun;
    }
  }

  private start(conversation: Conversation, input: SendMessage, context: string | null, requestDigest: string) {
    const { workspaceId, id } = conversation;
    const key = `${workspaceId}/${id}`;
    const record = this.record(workspaceId, id);
    const run: ConversationRun = {
      id: input.id,
      conversationId: id,
      status: 'accepted',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      errorCode: null,
    };
    record.requestDigest = requestDigest;
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
          throw new ApiError(502, 'model_failed', last.errorMessage || t('errors.modelFailed'));
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
            : t('errors.conversationFailed');
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
        this.release(key, record);
      }
    })();
    void record.execution.catch((error) => {
      console.error('Pi cleanup failed', run.id, error);
      record.execution = undefined;
      record.snapshot.error = t('errors.historyRead');
      this.emit(record);
      this.release(key, record);
    });
    return run;
  }

  rename(workspaceId: string, id: string, name: string) {
    const manager = this.conversations.get(`${workspaceId}/${id}`)?.session?.agent.sessionManager;
    return renameConversation(this.config.workspaceDir, workspaceId, id, name, manager);
  }

  async stop(workspaceId: string, id: string, runId: string) {
    getConversation(this.config.workspaceDir, workspaceId, id);
    const record = this.conversations.get(`${workspaceId}/${id}`);
    if (record?.snapshot.run?.id === runId && record.execution) {
      record.controller?.abort();
      await record.session?.agent.abort();
      await record.execution;
    }
    return record?.snapshot.run ?? this.recent.get(`${workspaceId}/${id}`)?.run ?? null;
  }
}
