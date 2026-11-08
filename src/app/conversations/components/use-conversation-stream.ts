'use client';

import { useTranslations } from 'use-intl';

import { useEffect, useState } from 'react';

import { requestJson } from '@/shared/http/request-json';

import { conversationEventSchema, type ConversationSnapshot } from '../schema';

export function useConversationStream(url: string) {
  const t = useTranslations();
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const stream = new EventSource(`${url}/events`);
    let fallback: AbortController | undefined;
    stream.onopen = () => {
      fallback?.abort();
      setConnected(true);
      setError('');
    };
    stream.onmessage = (event) => {
      try {
        const next = conversationEventSchema.parse(JSON.parse(event.data)).snapshot;
        fallback?.abort();
        setSnapshot(next);
      } catch {
        setError(t('errors.conversationData'));
      }
    };
    stream.onerror = () => {
      setConnected(false);
      fallback?.abort();
      const controller = new AbortController();
      fallback = controller;
      void requestJson<ConversationSnapshot>(url, { signal: controller.signal })
        .then(value => {
          if (!controller.signal.aborted) setSnapshot(value);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(error.message);
        });
    };
    return () => {
      fallback?.abort();
      stream.close();
    };
  }, [url, t]);
  return { snapshot, connected, error };
}
