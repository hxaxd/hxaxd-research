import type { useTranslations } from 'use-intl';

import type { SpeechSettings } from './schema';

export type ActiveSpeech = {
  id: string;
  name: string;
  protocol: 'realtime' | 'file';
  model: string;
};

export function activeSpeech(settings: SpeechSettings | null, t: ReturnType<typeof useTranslations>): ActiveSpeech | null {
  if (!settings?.activeId) return null;
  if (settings.activeId === 'chatgpt')
    return settings.chatgpt.connected
      ? {
          id: 'chatgpt',
          name: t('models.chatgptAuth'),
          protocol: 'realtime',
          model: settings.chatgpt.model,
        }
      : null;
  const connection = settings.connections.find(
    (item) => item.id === settings.activeId,
  );
  return connection
    ? {
        id: connection.id,
        name: connection.name,
        protocol: connection.protocol,
        model: connection.model,
      }
    : null;
}

export function speechUnavailable(settings: SpeechSettings | null, t: ReturnType<typeof useTranslations>) {
  if (!settings) return t('speech.settingsLoading');
  if (!settings.activeId) return t('speech.noSelection');
  if (settings.activeId === 'chatgpt') return t('speech.chatgptDisconnected');
  return t('speech.unavailable');
}
