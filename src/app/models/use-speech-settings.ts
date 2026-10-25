'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { requestJson } from '@/shared/http/request-json';
import type { SpeechSettings } from './schema';

const initial: { settings: SpeechSettings | null; error: string } = { settings: null, error: '' };
let snapshot = initial;
let pending: Promise<void> | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => snapshot;
const getServerSnapshot = () => initial;

function publish(next: typeof initial) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function publishSpeechSettings(settings: SpeechSettings) { publish({ settings, error: '' }); }

function refreshSpeechSettings() {
  pending ??= requestJson<SpeechSettings>('/api/speech')
    .then(publishSpeechSettings)
    .catch((error: Error) => { publish({ ...snapshot, error: error.message }); })
    .finally(() => { pending = undefined; });
  return pending;
}

export function useSpeechSettings() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => { void refreshSpeechSettings(); }, []);
  return { ...state, refresh: refreshSpeechSettings };
}
