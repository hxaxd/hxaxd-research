import { z } from 'zod';
export const relativePathSchema = z.string().max(2048);
export const fileEntrySchema = z.object({ path: relativePathSchema, name: z.string(), kind: z.enum(['file', 'directory']), size: z.number(), modifiedAt: z.string() });
export const materialReferenceSchema = z.object({ path: relativePathSchema.min(1), hash: z.string().regex(/^[a-f0-9]{64}$/).optional() });
export const importResultSchema = z.object({ requestId: z.uuid(), path: relativePathSchema, files: z.number(), bytes: z.number(), duplicate: z.boolean() });
export const textFileSchema = z.object({ path: z.string(), text: z.string(), hash: z.string(), offset: z.number(), truncated: z.boolean(), size: z.number() });
export type FileEntry = z.infer<typeof fileEntrySchema>;
export type MaterialReference = z.infer<typeof materialReferenceSchema>;
export type ImportResult = z.infer<typeof importResultSchema>;
