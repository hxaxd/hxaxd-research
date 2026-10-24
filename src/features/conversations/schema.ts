import { z } from 'zod';

import { maxImageClips, imageClipSchema, readingContextSchema, textQuotesSchema } from '@/features/files/schema';
import { createNamedSchema, idSchema } from '@/shared/schema';

export const createConversationSchema = createNamedSchema;
export const conversationSchema = createConversationSchema.extend({
  workspaceId: idSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const sendMessageSchema = z.object({
  id: idSchema,
  text: z.string().trim().min(1).max(100000),
  model: z.string().min(1),
  reading: readingContextSchema.nullable().default(null),
  clips: z.array(imageClipSchema).max(maxImageClips).optional(),
  quotes: textQuotesSchema.optional(),
});
export const stopRunSchema = z.object({ id: idSchema });
export const conversationImageQuerySchema = z.object({
  message: z.coerce.number().int().positive(),
  index: z.coerce.number().int().nonnegative(),
});
export const runStatusSchema = z.enum(['accepted', 'running', 'completed', 'cancelled', 'failed']);
export const runSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  status: runStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
});
export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'tool']),
  text: z.string(),
  images: z.array(z.object({ url: z.string() })).optional(),
  quotes: textQuotesSchema.optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
});
export const conversationSnapshotSchema = z.object({
  revision: z.number(),
  messages: z.array(chatMessageSchema),
  run: runSchema.nullable(),
  error: z.string().nullable(),
});
export const conversationEventSchema = z.object({
  type: z.literal('snapshot'),
  snapshot: conversationSnapshotSchema,
});
export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationRun = z.infer<typeof runSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
export type SendMessage = z.infer<typeof sendMessageSchema>;
