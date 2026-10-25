import { z } from 'zod';

import { idSchema } from '@/shared/schema';

export const thinkingLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
const modelSchema = z.object({ id: z.string(), name: z.string(), provider: z.string(), input: z.array(z.enum(['text', 'image'])), thinkingLevels: z.array(thinkingLevelSchema) });
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
  providerId: z.string(),
  status: z.enum(['starting', 'waiting', 'exchanging', 'connected', 'cancelled', 'failed']),
  url: z.string().nullable(),
  manualInput: z.boolean(),
  error: z.string().nullable(),
});
const modelApiSchema = z.enum(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']);
const connectionModelSchema = z.object({
  id: z.string().trim().min(1),
  reset: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
});
const connectionBaseUrlSchema = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
});
const connectionInputSchema = z.object({
  name: z.string().trim().max(160).default(''),
  baseUrl: connectionBaseUrlSchema,
  key: z.string().max(4096).optional(),
  clearKey: z.boolean().optional(),
});
export const modelDiscoverySchema = connectionInputSchema.omit({ name: true }).extend({
  connectionId: z.string().min(1).optional(),
  speechConnectionId: z.string().min(1).optional(),
  api: modelApiSchema,
});
export const modelConnectionInputSchema = connectionInputSchema.extend({
  api: modelApiSchema,
  models: z.array(connectionModelSchema).min(1),
});
const discoveredModelSchema = connectionModelSchema.omit({ reset: true }).extend({
  name: z.string(),
  recognized: z.boolean(),
  customized: z.boolean().optional(),
  automatic: connectionModelSchema.omit({ id: true, reset: true }).optional(),
});
export const modelDiscoveryResultSchema = z.object({ models: z.array(discoveredModelSchema) });
const modelConnectionSchema = z.object({
  id: z.string(), name: z.string(), baseUrl: z.string(), api: z.string(),
  models: z.array(discoveredModelSchema),
});
export const modelConnectionIdSchema = z.string().regex(/^[\w.-]+$/).max(160);
export const providerSettingsSchema = z.object({
  authorizationProviders: z.array(z.object({
    id: z.string(),
    name: z.string(),
    capabilities: z.array(z.enum(['text', 'speech'])),
  })),
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
  connections: z.array(modelConnectionSchema),
});
export type ConfiguredModel = z.infer<typeof modelSchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export type Authorization = z.infer<typeof authorizationSchema>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export type ModelConnectionInput = z.infer<typeof modelConnectionInputSchema>;
export type ModelDiscoveryInput = z.infer<typeof modelDiscoverySchema>;
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;
export type ModelConnection = z.infer<typeof modelConnectionSchema>;

const speechProtocolSchema = z.enum(['realtime', 'file']);

export const speechConnectionInputSchema = connectionInputSchema.extend({
  protocol: speechProtocolSchema,
  model: z.string().trim().min(1).max(200),
});

const speechConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: speechProtocolSchema,
  baseUrl: z.string(),
  model: z.string(),
  hasKey: z.boolean(),
});

export const speechSettingsSchema = z.object({
  activeId: z.string().nullable(),
  chatgpt: z.object({ connected: z.boolean(), model: z.string() }),
  connections: z.array(speechConnectionSchema),
});

export const speechSelectionSchema = z.object({ activeId: z.string().nullable() });
export const speechChatgptSchema = z.object({
  model: z.string().trim().min(1).max(200),
});
export const speechConnectionRefSchema = z.object({
  connectionId: z.string().min(1),
});

export type SpeechProtocol = z.infer<typeof speechProtocolSchema>;
export type SpeechConnection = z.infer<typeof speechConnectionSchema>;
export type SpeechSettings = z.infer<typeof speechSettingsSchema>;
export type SpeechConnectionInput = z.infer<typeof speechConnectionInputSchema>;
