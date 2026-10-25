import { z } from 'zod';

import { createNamedSchema } from '@/shared/schema';

export const createWorkspaceSchema = createNamedSchema;
export const workspaceSchema = createWorkspaceSchema.extend({
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;
