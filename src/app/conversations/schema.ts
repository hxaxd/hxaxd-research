import { z } from 'zod';

import { maxImageClips, imageClipSchema, readingContextSchema, quoteTextSchema, textQuoteSchema } from '@/app/files/schema';
import { thinkingLevelSchema } from '@/app/models/schema';
import { createNamedSchema, idSchema } from '@/shared/schema';

export const createConversationSchema = createNamedSchema;
export const conversationSchema = createConversationSchema.extend({
  workspaceId: idSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
const assistantQuoteSchema = z.object({ messageId: z.string().min(1).max(128), text: quoteTextSchema });
export const maxTextQuotes = 12;
export const textQuotesSchema = z.array(z.union([assistantQuoteSchema, textQuoteSchema])).max(maxTextQuotes);
export type AssistantQuote = z.infer<typeof assistantQuoteSchema>;
export type ConversationQuote = z.infer<typeof textQuotesSchema>[number];
export const sendMessageSchema = z.object({
  id: idSchema,
  text: z.string().trim().min(1).max(100000),
  model: z.string().min(1),
  thinkingLevel: thinkingLevelSchema.optional(),
  reading: readingContextSchema.nullable().default(null),
  clips: z.array(imageClipSchema).max(maxImageClips).optional(),
  quotes: textQuotesSchema.optional(),
  queueIfBusy: z.boolean().optional(),
});
export const stopRunSchema = z.object({ id: idSchema, pending: z.boolean().optional() });
export const answerQuestionSchema = z.object({
  id: z.string().min(1),
  answer: z.string().trim().min(1).max(10000).nullable(),
});
export const questionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  options: z.array(z.string()),
  answer: z.string().nullable().optional(),
});
export type UserQuestion = z.infer<typeof questionSchema>;
export const conversationImageQuerySchema = z.object({
  message: z.coerce.number().int().positive(),
  index: z.coerce.number().int().nonnegative(),
});
const runStatusSchema = z.enum(['accepted', 'running', 'completed', 'cancelled', 'failed']);
export const runSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  status: runStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  retrying: z.boolean(),
});
export const queuedMessageSchema = z.object({ id: idSchema, text: z.string(), status: z.literal('queued') });
export const messageSubmissionSchema = z.union([
  runSchema, queuedMessageSchema, z.object({ id: idSchema, status: z.literal('received') }),
]);
const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'tool']),
  text: z.string(),
  images: z.array(z.object({ url: z.string() })).optional(),
  quotes: textQuotesSchema.optional(),
  toolName: z.string().optional(),
  /** Tool call arguments, shown as the call's input. */
  args: z.record(z.string(), z.unknown()).optional(),
  pending: z.boolean().optional(),
  isError: z.boolean().optional(),
  question: questionSchema.optional(),
});
export const conversationSnapshotSchema = z.object({
  revision: z.number(),
  messages: z.array(chatMessageSchema),
  run: runSchema.nullable(),
  queue: z.array(queuedMessageSchema),
  error: z.string().nullable(),
});
export const conversationEventSchema = z.object({
  type: z.literal('snapshot'),
  snapshot: conversationSnapshotSchema,
});
export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationRun = z.infer<typeof runSchema>;
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
export type SendMessage = z.infer<typeof sendMessageSchema>;
