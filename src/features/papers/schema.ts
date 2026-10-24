import { z } from 'zod';

import { createNamedSchema, idSchema } from '@/shared/schema';

export const createPaperSchema = createNamedSchema;
export const paperMetadataSchema = createPaperSchema.extend({
  path: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const paperSchema = paperMetadataSchema.extend({ workspaceId: idSchema });
export type Paper = z.infer<typeof paperSchema>;
