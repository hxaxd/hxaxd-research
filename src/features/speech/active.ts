import type { SpeechSettings } from './schema';

export type ActiveSpeech = {
  id: string;
  name: string;
  protocol: 'realtime' | 'file';
  model: string;
};

export function activeSpeech(settings: SpeechSettings | null): ActiveSpeech | null {
  if (!settings?.activeId) return null;
  if (settings.activeId === 'chatgpt')
    return settings.chatgpt.connected
      ? {
          id: 'chatgpt',
          name: 'ChatGPT 授权',
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

export function speechUnavailable(settings: SpeechSettings | null) {
  if (!settings) return '正在读取语音设置…';
  if (!settings.activeId) return '尚未选择语音输入方式';
  if (settings.activeId === 'chatgpt') return 'ChatGPT 授权尚未连接';
  return '当前选择的语音连接不可用';
}
