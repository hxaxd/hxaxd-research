import { z } from 'zod';

import { createNamedSchema } from '@/shared/schema';
import { paperMetadataSchema } from '@/features/papers/schema';

export const createWorkspaceSchema = createNamedSchema;
export const workspaceSchema = createWorkspaceSchema.extend({
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export const workspaceConfigSchema = workspaceSchema.extend({
  papers: z.array(paperMetadataSchema),
});
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
