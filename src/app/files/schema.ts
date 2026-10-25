import { z } from 'zod';

const relativePathSchema = z.string().max(2048);
export const createDirectorySchema = z.object({ path: relativePathSchema.min(1) });
export const directoryResultSchema = z.object({ path: relativePathSchema });
export const importMetadataSchema = z.object({
  target: relativePathSchema.default(''),
  folderName: z.string().max(160).optional(),
});
export const fileEntrySchema = z.object({
  path: relativePathSchema,
  name: z.string(),
  kind: z.enum(['file', 'directory']),
  size: z.number(),
  modifiedAt: z.string(),
});
export const readingContextSchema = z.object({
  path: relativePathSchema.min(1),
  page: z.number().int().positive().optional(),
  mode: z.enum(['source', 'preview']).optional(),
});
export const readerRequestSchema = readingContextSchema.extend({
  id: z.string(),
  conversationId: z.uuid(),
});
export type DocumentRequest = ReadingContext & { id: string };
export type ReaderRequest = z.infer<typeof readerRequestSchema>;
export type ViewMode = 'source' | 'preview';
export const importResultSchema = z.object({
  path: relativePathSchema,
  files: z.number(),
  bytes: z.number(),
});
export const textFileSchema = z.object({
  path: z.string(),
  text: z.string(),
  offset: z.number(),
  truncated: z.boolean(),
  size: z.number(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;
export type ReadingContext = z.infer<typeof readingContextSchema>;
export const maxTextQuotes = 12;
const textQuoteSchema = readingContextSchema.extend({ text: z.string().trim().min(1).max(10000) });
export const textQuotesSchema = z.array(textQuoteSchema).max(maxTextQuotes);
export type TextQuote = z.infer<typeof textQuoteSchema>;
export const maxImageClips = 6;
export const imageClipSchema = z.object({
  path: relativePathSchema.min(1),
  page: z.number().int().positive().optional(),
  data: z.string().min(1).max(8 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type ImageClip = z.infer<typeof imageClipSchema>;
export type ImportResult = z.infer<typeof importResultSchema>;
export const fileChangeSchema = z.object({ paths: z.array(relativePathSchema) });
