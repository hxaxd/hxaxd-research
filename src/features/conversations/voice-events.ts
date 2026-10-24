export type VoiceItem = { text: string; done: boolean };

export type VoiceServerEvent = {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
};

export function applyVoiceEvent(
  items: Map<string, VoiceItem>,
  event: VoiceServerEvent,
): { completed: string | null; error: string | null } {
  if (event.type === 'conversation.item.input_audio_transcription.delta') {
    const id = event.item_id ?? 'item';
    const current = items.get(id);
    if (current?.done) return { completed: null, error: null };
    const next = current ?? { text: '', done: false };
    next.text += event.delta ?? '';
    items.set(id, next);
    return { completed: null, error: null };
  }
  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    const id = event.item_id ?? 'item';
    const current = items.get(id);
    if (current?.done) return { completed: null, error: null };
    const next = current ?? { text: '', done: false };
    next.text = event.transcript ?? next.text;
    next.done = true;
    items.set(id, next);
    return { completed: next.text, error: null };
  }
  if (
    event.type === 'error' ||
    event.type === 'conversation.item.input_audio_transcription.failed'
  ) {
    const detail = event.error?.message?.slice(0, 120);
    return {
      completed: null,
      error: detail ? `语音服务返回错误：${detail}` : '语音服务返回错误',
    };
  }
  return { completed: null, error: null };
}

export function pendingVoiceText(items: Map<string, VoiceItem>) {
  return [...items.values()]
    .filter((item) => !item.done)
    .map((item) => item.text)
    .join('')
    .trim();
}
