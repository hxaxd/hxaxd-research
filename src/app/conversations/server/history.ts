import 'server-only';
import { text as t } from '@/app/i18n/server.mjs';

import { ApiError } from '@/shared/http/api-error';

import { openConversation } from './conversations';
import { mapPiMessage, toolCallArgs } from './pi-events';
import { textQuotesSchema, type TextQuote } from '@/app/files/schema';

export function readConversationHistory(root: string, workspaceId: string, id: string) {
  let quotes: TextQuote[] = [];
  const args = new Map<string, Record<string, unknown>>();
  return openConversation(root, workspaceId, id)
    .getBranch()
    .flatMap((entry) => {
      if (entry.type === 'custom_message' && entry.customType === 'reading-context') {
        const details = entry.details as { quotes?: unknown } | undefined;
        quotes = textQuotesSchema.parse(details?.quotes ?? []);
      }
      if (entry.type !== 'message') return [];
      for (const [callId, value] of toolCallArgs(entry.message)) args.set(callId, value);
      const message = mapPiMessage(entry.id, entry.message, `/api/workspaces/${workspaceId}/conversations/${id}/images`, args);
      if (message?.role === 'user') {
        if (quotes.length) message.quotes = quotes;
        quotes = [];
      }
      return message ? [message] : [];
    });
}

export function readConversationImage(root: string, workspaceId: string, id: string, timestamp: number, index: number) {
  for (const entry of openConversation(root, workspaceId, id).getBranch()) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role !== 'user' || message.timestamp !== timestamp) continue;
    const { content } = message;
    const image = Array.isArray(content) ? content.filter(item => item.type === 'image')[index] : undefined;
    if (!image) break;
    return new Response(Buffer.from(image.data, 'base64'), { headers: {
      'Content-Type': image.mimeType,
      'Cache-Control': 'private, max-age=31536000, immutable',
    } });
  }
  throw new ApiError(404, 'image_not_found', t('errors.imageMissing'));
}
