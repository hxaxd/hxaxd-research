'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiErrorSchema } from '@/shared/http/api-error';

import { messageSubmissionSchema, runSchema, type ConversationSnapshot, type SendMessage } from '../schema';

export type Delivery = {
  input: SendMessage;
  status: 'sending' | 'retrying' | 'accepted' | 'stopping' | 'stopped' | 'failed';
  error?: string;
  retryWithNewId?: boolean;
};

const retryableStatuses = [408, 429, 502, 503, 504];

function waitToRetry(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    const timer = setTimeout(done, 2_000);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function deliver(url: string, body: object, signal: AbortSignal, onRetry: () => void) {
  const payload = JSON.stringify(body);
  while (!signal.aborted) {
    const attempt = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: attempt,
      });
      if (!retryableStatuses.includes(response.status)) {
        const data: unknown = await response.json();
        if (response.ok) return { data };
        return { error: apiErrorSchema.parse(data).error.message };
      }
      await response.body?.cancel();
    } catch (error) {
      if (!(error instanceof TypeError) && !attempt.aborted) throw error;
    }
    if (signal.aborted) return;
    onRetry();
    await waitToRetry(signal);
  }
}

export function useMessageDelivery() {
  const [byUrl, setByUrl] = useState<Record<string, Delivery[]>>({});
  const requests = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const current = requests.current;
    return () => {
      for (const controller of current.values()) controller.abort();
      current.clear();
    };
  }, []);

  const update = useCallback((url: string, id: string, change: Partial<Delivery> | null) => {
    setByUrl(current => ({
      ...current,
      [url]: (current[url] ?? []).flatMap(item =>
        item.input.id !== id ? [item] : change ? [{ ...item, ...change }] : []),
    }));
  }, []);

  async function run(url: string, input: SendMessage, stop: boolean) {
    const { id } = input;
    const controller = new AbortController();
    requests.current.get(id)?.abort();
    requests.current.set(id, controller);
    try {
      const result = await deliver(
        `${url}/${stop ? 'stop' : 'messages'}`,
        stop ? { id, pending: true } : input,
        controller.signal,
        () => { if (!stop) update(url, id, { status: 'retrying' }); },
      );
      if (!result || controller.signal.aborted) return;
      if (result.error !== undefined) {
        update(url, id, { status: 'failed', error: result.error });
      } else if (stop) {
        runSchema.nullable().parse(result.data);
        update(url, id, { status: 'stopped' });
      } else {
        const submission = messageSubmissionSchema.parse(result.data);
        update(url, id, submission.status === 'failed'
          ? { status: 'failed', retryWithNewId: true }
          : submission.status === 'cancelled' ? { status: 'stopped' } : { status: 'accepted' });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('Invalid message delivery response', error);
        update(url, id, { status: 'failed' });
      }
    } finally {
      if (requests.current.get(id) === controller) requests.current.delete(id);
    }
  }

  function send(url: string, input: SendMessage) {
    setByUrl(current => ({
      ...current,
      [url]: [...(current[url] ?? []).filter(item => item.status !== 'failed' && item.status !== 'stopped'),
        { input, status: 'sending' }],
    }));
    void run(url, input, false);
  }

  function retry(url: string, { input, status, retryWithNewId }: Delivery) {
    send(url, status === 'stopped' || retryWithNewId ? { ...input, id: crypto.randomUUID() } : input);
  }

  function dismiss(url: string, id: string) {
    update(url, id, null);
  }

  function stop(url: string, input: SendMessage) {
    update(url, input.id, { status: 'stopping' });
    void run(url, input, true);
  }

  const observe = useCallback((url: string, items: Delivery[], snapshot: ConversationSnapshot) => {
    for (const { input: { id }, status } of items) {
      if (status === 'stopping') continue;
      if (snapshot.messages.some(message => message.id === id) ||
          (status !== 'stopped' && snapshot.queue.some(message => message.id === id))) {
        requests.current.get(id)?.abort();
        update(url, id, null);
      } else if (snapshot.run?.id === id && (status === 'sending' || status === 'retrying' || status === 'accepted')) {
        requests.current.get(id)?.abort();
        const next = snapshot.run.status === 'failed' ? 'failed'
          : snapshot.run.status === 'cancelled' ? 'stopped' : 'accepted';
        if (status !== next) update(url, id, {
          status: next,
          ...(next === 'failed' && { error: snapshot.error ?? undefined, retryWithNewId: true }),
        });
      }
    }
  }, [update]);

  return { byUrl, send, retry, dismiss, stop, observe };
}
