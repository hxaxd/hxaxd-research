import 'server-only';
import { text as t } from '@/app/i18n/server.mjs';

import { createHash } from 'node:crypto';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

import type { ModelProviders } from '@/app/models/server/providers';
import type { AppConfig } from '@/app/config.mjs';
import type { ReaderController } from '@/app/files/server/reader';
import { readAssistantPrompt } from '@/app/settings/server/assistant-prompt';
import { ApiError, isApiError } from '@/shared/http/api-error';

import type { Conversation, ConversationRun, ConversationSnapshot, QueuedMessage, SendMessage, UserQuestion } from '../schema';
import { getConversation, openConversation, renameConversation } from './conversations';
import { readConversationHistory, savedSubmissionDigest, submissionEntryType } from './history';
import { mapPiEvent } from './pi-events';
import { buildReadingContext } from './reading-context';
import { createPiSession } from './session';

type PendingSubmission = {
  input: SendMessage;
  context: string | null;
  requestDigest: string;
};

function queuedMessage({ input }: PendingSubmission): QueuedMessage {
  return { id: input.id, text: input.text.length > 160 ? `${input.text.slice(0, 160)}…` : input.text, status: 'queued' };
}

type LiveConversation = {
  snapshot: ConversationSnapshot;
  listeners: Set<(snapshot: ConversationSnapshot) => void>;
  queue: PendingSubmission[];
  session?: { agent: AgentSession; additionalPrompt: string };
  execution?: Promise<void>;
  controller?: AbortController;
  requestDigest?: string;
  questions: Map<string, (answer: string | null) => void>;
};

type RecentConversation = Pick<ConversationSnapshot, 'revision' | 'run' | 'error'>;
const recentConversationLimit = 128;
const queueLimit = 8;

export class PiSessionRegistry {
  private readonly conversations = new Map<string, LiveConversation>();
  private readonly recent = new Map<string, RecentConversation>();
  private readonly receipts = new Map<string, { run: ConversationRun; requestDigest: string } | null>();

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
        listeners: new Set(),
        queue: [],
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
      queue: record?.queue.map(queuedMessage) ?? [],
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
    record.snapshot = { ...record.snapshot, revision: record.snapshot.revision + 1, queue: record.queue.map(queuedMessage) };
    for (const listener of record.listeners) listener(record.snapshot);
  }

  private release(key: string, record: LiveConversation) {
    if (record.execution || record.queue.length || record.listeners.size || this.conversations.get(key) !== record) return;
    this.conversations.delete(key);
    record.session?.agent.dispose();
    const { revision, run, error } = record.snapshot;
    if (!run) return;
    this.recent.delete(key);
    this.recent.set(key, { revision, run, error });
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
    const manager = openConversation(root, workspaceId, id);
    const conversation = getConversation(root, workspaceId, id, manager);
    const key = `${workspaceId}/${id}`;
    const { queueIfBusy, ...message } = input;
    const requestDigest = createHash('sha256').update(JSON.stringify(message)).digest('hex');
    const previous = this.existingSubmission(key, input.id, requestDigest);
    if (previous) return previous;
    const savedDigest = savedSubmissionDigest(manager, input.id);
    if (savedDigest) {
      if (savedDigest !== requestDigest) throw new ApiError(409, 'conflict', t('errors.requestConflict'));
      return { id: input.id, status: 'received' as const };
    }
    if (!queueIfBusy) this.requireIdle(key);
    let context: string | null;
    try {
      context = await buildReadingContext(root, workspaceId, input.reading, input.clips, input.quotes);
    } catch (error) {
      const existing = this.existingSubmission(key, input.id, requestDigest);
      if (existing) return existing;
      throw error;
    }
    const existing = this.existingSubmission(key, input.id, requestDigest);
    if (existing) return existing;
    if (!queueIfBusy) this.requireIdle(key);
    const record = this.record(workspaceId, id);
    const submission = { input, context, requestDigest };
    if (!record.execution && !record.queue.length) return this.start(conversation, record, submission);
    if (record.queue.length >= queueLimit) throw new ApiError(409, 'queue_full', t('errors.conversationQueueFull'));
    record.queue.push(submission);
    this.emit(record);
    return queuedMessage(submission);
  }

  removeQueued(workspaceId: string, id: string, messageId: string) {
    getConversation(this.config.workspaceDir, workspaceId, id);
    const key = `${workspaceId}/${id}`;
    const record = this.conversations.get(key);
    const index = record?.queue.findIndex(item => item.input.id === messageId) ?? -1;
    if (!record || index < 0) return { removed: false };
    record.queue.splice(index, 1);
    this.emit(record);
    this.release(key, record);
    return { removed: true };
  }

  resumeQueue(workspaceId: string, id: string) {
    const conversation = getConversation(this.config.workspaceDir, workspaceId, id);
    const record = this.conversations.get(`${workspaceId}/${id}`);
    if (!record || record.execution) return null;
    const next = record.queue.shift();
    return next ? this.start(conversation, record, next) : null;
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

  private requireIdle(key: string) {
    const active = this.conversations.get(key);
    if (active?.execution || active?.queue.length)
      throw new ApiError(409, 'busy', t('errors.conversationBusy'));
  }

  private existingSubmission(key: string, requestId: string, requestDigest: string) {
    const active = this.conversations.get(key);
    const activeRun = active?.snapshot.run;
    const queued = active?.queue.find(item => item.input.id === requestId);
    const receipt = this.receipts.get(`${key}/${requestId}`);
    if (receipt === null) throw new ApiError(409, 'submission_cancelled', t('conversations.sendStopped'));
    const previous = queued ? { run: queuedMessage(queued), requestDigest: queued.requestDigest }
      : activeRun?.id === requestId && active?.execution
        ? { run: activeRun, requestDigest: active.requestDigest }
        : receipt;
    if (previous) {
      if (previous.requestDigest !== requestDigest)
        throw new ApiError(409, 'conflict', t('errors.requestConflict'));
      return previous.run;
    }
  }

  private remember(key: string, receipt: { run: ConversationRun; requestDigest: string } | null) {
    this.receipts.set(key, receipt);
    if (this.receipts.size > recentConversationLimit) {
      const oldest = this.receipts.keys().next();
      if (!oldest.done) this.receipts.delete(oldest.value);
    }
  }

  private start(conversation: Conversation, record: LiveConversation, { input, context, requestDigest }: PendingSubmission) {
    const { workspaceId, id } = conversation;
    const key = `${workspaceId}/${id}`;
    const run: ConversationRun = {
      id: input.id,
      conversationId: id,
      status: 'accepted',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      errorCode: null,
      retrying: false,
    };
    record.requestDigest = requestDigest;
    record.snapshot = { ...record.snapshot, run, error: null };
    record.controller = new AbortController();
    const signal = record.controller.signal;
    record.execution = (async () => {
      let unsubscribe: (() => void) | undefined;
      try {
        const session = await this.sessionFor(record, conversation, input, signal);
        let liveId = '';
        let sequence = 0;
        unsubscribe = session.subscribe((event) => {
          if (event.type === 'auto_retry_start') run.retrying = true;
          if (event.type === 'auto_retry_end') run.retrying = false;
          if (event.type === 'message_start') {
            if (event.message.role === 'assistant') run.retrying = false;
            liveId = event.message.role === 'user' ? run.id : `live:${run.id}:${sequence++}`;
          }
          record.snapshot = {
            ...record.snapshot,
            messages: mapPiEvent(event, record.snapshot.messages, liveId, `/api/workspaces/${workspaceId}/conversations/${id}/images`, input.quotes),
          };
          this.emit(record);
        });
        run.status = 'running';
        this.emit(record);
        session.sessionManager.appendCustomEntry(submissionEntryType, { id: run.id, digest: requestDigest });
        if (context) await session.sendCustomMessage({
          customType: 'reading-context', content: context, display: false,
          details: { quotes: input.quotes ?? [] },
        });
        signal.throwIfAborted();
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
        run.retrying = false;
        this.remember(`${key}/${run.id}`, { run, requestDigest });
        record.snapshot = {
          ...record.snapshot,
          messages: readConversationHistory(this.config.workspaceDir, workspaceId, id),
        };
        const next = run.status === 'completed' ? record.queue.shift() : undefined;
        if (next) this.start(conversation, record, next);
        else {
          this.emit(record);
          this.release(key, record);
        }
      }
    })();
    this.emit(record);
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

  async stop(workspaceId: string, id: string, runId: string, pending = false) {
    getConversation(this.config.workspaceDir, workspaceId, id);
    const key = `${workspaceId}/${id}`;
    const record = this.conversations.get(key);
    const run = record?.snapshot.run;
    const execution = record?.execution;
    if (record && run?.id === runId && execution) {
      record.controller?.abort();
      await record.session?.agent.abort();
      await execution;
      return run;
    }
    if (pending) {
      const receiptKey = `${key}/${runId}`;
      const receipt = this.receipts.get(receiptKey);
      if (receipt) return receipt.run;
      this.remember(receiptKey, null);
      this.removeQueued(workspaceId, id, runId);
      return null;
    }
    return run ?? this.recent.get(key)?.run ?? null;
  }
}
