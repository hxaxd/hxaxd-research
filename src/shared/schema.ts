import { z } from 'zod';

export const idSchema = z.uuid();
export const nameSchema = z.string().trim().min(1).max(160);
export const createNamedSchema = z.object({ id: idSchema, name: nameSchema });
export const renameSchema = z.object({ name: nameSchema });
