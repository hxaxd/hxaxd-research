import { z } from 'zod';
export const idSchema = z.uuid();
export const nameSchema = z.string().trim().min(1).max(160);
export const createWorkspaceSchema = z.object({ id: idSchema, name: nameSchema });
export const renameSchema = z.object({ name: nameSchema });
export const workspaceSchema = createWorkspaceSchema.extend({ createdAt: z.string(), updatedAt: z.string() });
export type Workspace = z.infer<typeof workspaceSchema>;
