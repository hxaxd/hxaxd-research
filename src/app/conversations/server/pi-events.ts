import 'server-only';

import { parseSkillBlock, type AgentSessionEvent, type SessionMessageEntry } from '@earendil-works/pi-coding-agent';

import type { ChatMessage, ConversationQuote } from '../schema';
import { questionSchema } from '../schema';
import { skillCommandPrefix } from '../skill-command';

type PiMessage = SessionMessageEntry['message'];

function questionOf(details: unknown) {
  const result = questionSchema.safeParse((details as { question?: unknown } | undefined)?.question);
  return result.success ? result.data : undefined;
}

function textOf(
  content: Extract<PiMessage, { role: 'user' | 'assistant' | 'toolResult' }>['content'],
): string {
  if (typeof content === 'string') return content;
  return content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

function argsOf(value: unknown): Pick<ChatMessage, 'args'> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { args: value as Record<string, unknown> } : {};
}

/** Arguments of each tool call in an assistant message, keyed by call id. */
export function toolCallArgs(value: PiMessage): [string, Record<string, unknown>][] {
  if (value.role !== 'assistant' || typeof value.content === 'string') return [];
  return value.content.flatMap(item => item.type === 'toolCall' ? [[item.id, item.arguments] as [string, Record<string, unknown>]] : []);
}

export function mapPiMessage(id: string, value: PiMessage, imageBase: string, args?: Map<string, Record<string, unknown>>): ChatMessage | null {
  if (value.role === 'user' || value.role === 'assistant') {
    const content = textOf(value.content);
    const skill = value.role === 'user' ? parseSkillBlock(content) : null;
    const text = skill ? `${skillCommandPrefix}${skill.name}${skill.userMessage ? ` ${skill.userMessage}` : ''}` : content;
    const images = typeof value.content === 'string' ? [] : value.content
      .filter(item => item.type === 'image')
      .map((_, index) => ({ url: `${imageBase}?message=${value.timestamp}&index=${index}` }));
    return { id, role: value.role, text, ...(images.length ? { images } : {}) };
  }
  if (value.role === 'toolResult')
    return {
      id: `tool:${value.toolCallId}`,
      role: 'tool',
      text: textOf(value.content),
      toolName: value.toolName,
      ...argsOf(args?.get(value.toolCallId)),
      isError: value.isError,
      question: questionOf(value.details),
    };
  return null;
}

export function mapPiEvent(
  event: AgentSessionEvent,
  messages: ChatMessage[],
  liveId: string,
  imageBase: string,
  quotes?: ConversationQuote[],
): ChatMessage[] {
  if (
    event.type === 'message_start' ||
    event.type === 'message_update' ||
    event.type === 'message_end'
  ) {
    const message = mapPiMessage(liveId, event.message, imageBase);
    if (!message) return messages;
    if (message.role === 'user' && quotes?.length) message.quotes = quotes;
    const index = messages.findIndex((item) => item.id === message.id);
    return index < 0
      ? [...messages, message]
      : messages.map((item, i) => (i === index ? message : item));
  }
  if (event.type === 'tool_execution_start')
    return [
      ...messages.filter((message) => message.id !== `tool:${event.toolCallId}`),
      { id: `tool:${event.toolCallId}`, role: 'tool', toolName: event.toolName, pending: true, text: '', ...argsOf(event.args) },
    ];
  if (event.type === 'tool_execution_end')
    return messages.map((message) =>
      message.id === `tool:${event.toolCallId}`
        ? { ...message, pending: false, text: textOf(event.result.content), isError: event.isError, question: questionOf(event.result.details) }
        : message,
    );
  if (event.type === 'tool_execution_update')
    return messages.map(message => message.id === `tool:${event.toolCallId}`
      ? { ...message, question: questionOf(event.partialResult.details) } : message);
  return messages;
}
