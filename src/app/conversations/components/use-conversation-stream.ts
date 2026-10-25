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
    const controller = new AbortController();
    stream.onopen = () => {
      setConnected(true);
      setError('');
    };
    stream.onmessage = (event) => {
      try {
        setSnapshot(conversationEventSchema.parse(JSON.parse(event.data)).snapshot);
      } catch {
        setError(t('errors.conversationData'));
      }
    };
    stream.onerror = () => {
      setConnected(false);
      void requestJson<ConversationSnapshot>(url, { signal: controller.signal })
        .then(setSnapshot)
        .catch((error) => {
          if (!controller.signal.aborted) setError(error.message);
        });
    };
    return () => {
      controller.abort();
      stream.close();
    };
  }, [url, t]);
  return { snapshot, connected, error };
}
