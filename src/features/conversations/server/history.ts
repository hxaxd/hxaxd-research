import 'server-only';

import { ApiError } from '@/shared/http/api-error';

import { openConversation } from './conversations';
import { mapPiMessage } from './pi-events';
import { textQuotesSchema, type TextQuote } from '@/features/files/schema';

export function readConversationHistory(root: string, workspaceId: string, id: string) {
  let quotes: TextQuote[] = [];
  return openConversation(root, workspaceId, id)
    .getBranch()
    .flatMap((entry) => {
      if (entry.type === 'custom_message' && entry.customType === 'reading-context') {
        const details = entry.details as { quotes?: unknown } | undefined;
        quotes = textQuotesSchema.parse(details?.quotes ?? []);
      }
      if (entry.type !== 'message') return [];
      const message = mapPiMessage(entry.id, entry.message, `/api/workspaces/${workspaceId}/conversations/${id}/images`);
      if (message?.role === 'user') {
        if (quotes.length) message.quotes = quotes;
        quotes = [];
      }
      return message ? [message] : [];
    });
}

export function readConversationImage(root: string, workspaceId: string, id: string, timestamp: number, index: number) {
  const entry = openConversation(root, workspaceId, id).getBranch().find(entry =>
    entry.type === 'message' && entry.message.role === 'user' && entry.message.timestamp === timestamp,
  );
  const content = entry?.type === 'message' && entry.message.role === 'user' ? entry.message.content : null;
  const image = Array.isArray(content) ? content.filter(item => item.type === 'image')[index] : undefined;
  if (!image) throw new ApiError(404, 'image_not_found', '截图不存在');
  return new Response(Buffer.from(image.data, 'base64'), { headers: {
    'Content-Type': image.mimeType,
    'Cache-Control': 'private, max-age=31536000, immutable',
  } });
}
