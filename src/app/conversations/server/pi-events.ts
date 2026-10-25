import 'server-only';

import type { AgentSessionEvent, SessionMessageEntry } from '@earendil-works/pi-coding-agent';

import type { ChatMessage } from '../schema';
import type { TextQuote } from '@/app/files/schema';

type PiMessage = SessionMessageEntry['message'];

function textOf(
  content: Extract<PiMessage, { role: 'user' | 'assistant' | 'toolResult' }>['content'],
): string {
  if (typeof content === 'string') return content;
  return content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

export function mapPiMessage(id: string, value: PiMessage, imageBase: string): ChatMessage | null {
  if (value.role === 'user' || value.role === 'assistant') {
    const text = textOf(value.content);
    const images = typeof value.content === 'string' ? [] : value.content
      .filter(item => item.type === 'image')
      .map((_, index) => ({ url: `${imageBase}?message=${value.timestamp}&index=${index}` }));
    return { id, role: value.role, text, ...(images.length ? { images } : {}) };
  }
  if (value.role === 'toolResult')
    return {
      id,
      role: 'tool',
      text: textOf(value.content),
      toolName: value.toolName,
      isError: value.isError,
    };
  return null;
}

export function mapPiEvent(
  event: AgentSessionEvent,
  messages: ChatMessage[],
  liveId: string,
  imageBase: string,
  quotes?: TextQuote[],
): ChatMessage[] {
  if (
    event.type === 'message_start' ||
    event.type === 'message_update' ||
    event.type === 'message_end'
  ) {
    const message = mapPiMessage(liveId, event.message, imageBase);
    if (!message) return messages;
    if (message.role === 'user' && quotes?.length) message.quotes = quotes;
    const index = messages.findIndex((item) => item.id === liveId);
    return index < 0
      ? [...messages, message]
      : messages.map((item, i) => (i === index ? message : item));
  }
  if (event.type === 'tool_execution_start')
    return [
      ...messages.filter((message) => message.id !== `tool:${event.toolCallId}`),
      { id: `tool:${event.toolCallId}`, role: 'tool', toolName: event.toolName, text: '正在执行…' },
    ];
  if (event.type === 'tool_execution_end')
    return messages.map((message) =>
      message.id === `tool:${event.toolCallId}`
        ? { ...message, text: textOf(event.result.content), isError: event.isError }
        : message,
    );
  return messages;
}
