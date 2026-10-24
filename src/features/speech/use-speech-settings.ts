'use client';

import { useCallback, useEffect, useState } from 'react';

import { requestJson } from '@/shared/http/request-json';

import type { SpeechSettings } from './schema';

const speechChangedEvent = 'research-speech-changed';

export function notifySpeechChanged() {
  window.dispatchEvent(new Event(speechChangedEvent));
}

export function useSpeechSettings() {
  const [settings, setSettings] = useState<SpeechSettings | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await requestJson<SpeechSettings>('/api/speech', { signal });
      setSettings(next);
      setError('');
      return next;
    } catch (error) {
      if (!signal?.aborted) setError((error as Error).message);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void requestJson<SpeechSettings>('/api/speech', { signal: controller.signal })
      .then((next) => {
        setSettings(next);
        setError('');
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError((error as Error).message);
      });
    const changed = () => void refresh();
    window.addEventListener(speechChangedEvent, changed);
    return () => {
      controller.abort();
      window.removeEventListener(speechChangedEvent, changed);
    };
  }, [refresh]);

  return { settings, error, refresh };
}
