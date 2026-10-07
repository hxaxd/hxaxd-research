import { z } from 'zod';
import { createWorkspaceSchema, idSchema } from '@/features/workspaces/workspace-schema';
export const createPaperSchema = createWorkspaceSchema;
export const paperSchema = createPaperSchema.extend({ workspaceId: idSchema, createdAt: z.string(), updatedAt: z.string() });
export type Paper = z.infer<typeof paperSchema>;
