import { z } from 'zod';

import { idSchema } from '@/shared/schema';

export const modelSchema = z.object({ id: z.string(), name: z.string(), provider: z.string(), input: z.array(z.enum(['text', 'image'])) });
export const modelCatalogSchema = z.object({
  models: z.array(modelSchema),
  issues: z.array(z.object({ provider: z.string(), message: z.string() })),
});
export const authorizationRequestSchema = z.object({ id: idSchema });
export const authorizationCallbackSchema = authorizationRequestSchema.extend({
  url: z.url().max(16384),
});
export const authorizationSchema = z.object({
  id: idSchema,
  status: z.enum(['starting', 'waiting', 'exchanging', 'connected', 'cancelled', 'failed']),
  url: z.string().nullable(),
  manualInput: z.boolean(),
  error: z.string().nullable(),
});
export const providerSettingsSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      connected: z.boolean(),
      subscription: z.boolean(),
      canDisconnect: z.boolean(),
    }),
  ),
  authorization: authorizationSchema.nullable(),
});
export type ConfiguredModel = z.infer<typeof modelSchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export type Authorization = z.infer<typeof authorizationSchema>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
