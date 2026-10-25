import 'server-only';
import { text as t } from '@/app/i18n/server.mjs';

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import stripJsonComments from 'strip-json-comments';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

import type { AppConfig } from '@/app/config.mjs';
import { ApiError } from '@/shared/http/api-error';
import { SpeechConnections } from './speech-connections';
import type { DiscoveredModel, ModelConnectionInput, ModelDiscoveryInput } from '../schema';

const storedModel = z.looseObject({ id: z.string(), contextWindow: z.number().optional(), maxTokens: z.number().optional() });
const storedProvider = z.looseObject({ name: z.string().optional(), baseUrl: z.string().optional(),
  api: z.string().optional(), apiKey: z.string().optional(), models: z.array(storedModel).optional() });
const storedConfiguration = z.looseObject({ providers: z.record(z.string(), storedProvider) });
type CatalogModel = ReturnType<ModelRuntime['getModels']>[number];

function read(config: AppConfig) {
  const file = path.join(config.piDir, 'models.json');
  if (!existsSync(file)) return { providers: {} } as z.infer<typeof storedConfiguration>;
  const text = readFileSync(file, 'utf8');
  let value: unknown;
  try { value = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ''))); }
  catch { throw new ApiError(422, 'model_config_invalid', t('errors.modelsParse')); }
  const result = storedConfiguration.safeParse(value);
  if (!result.success) throw new ApiError(422, 'model_config_invalid', t('errors.modelsFormat'));
  return result.data;
}

function knownModel(runtime: ModelRuntime, id: string, api: string, connectionId?: string) {
  const candidates = runtime.getModels().filter(model => model.id === id && model.provider !== connectionId);
  return candidates.find(model => model.api === api) ?? candidates[0];
}

function describe(id: string, model?: CatalogModel): DiscoveredModel {
  const automatic = model ? { contextWindow: model.contextWindow, maxTokens: model.maxTokens, vision: model.input.includes('image'), reasoning: model.reasoning } : {};
  return { id, name: model?.name ?? id, recognized: Boolean(model), automatic, ...automatic };
}

export function listModelConnections(config: AppConfig, runtime: ModelRuntime) {
  return Object.entries(read(config).providers).map(([id, provider]) => ({
    id, name: provider.name ?? runtime.getProvider(id)?.name ?? id,
    baseUrl: provider.baseUrl ?? runtime.getModels(id)[0]?.baseUrl ?? '',
    api: provider.api ?? runtime.getModels(id)[0]?.api ?? 'openai-completions',
    models: (provider.models ?? runtime.getModels(id)).map(model => {
      const automatic = describe(model.id, knownModel(runtime, model.id, provider.api ?? '', id));
      const current = {
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        ...(Array.isArray(model.input) ? { vision: model.input.includes('image') } : {}),
        ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
      };
      return { ...automatic, ...current, customized: Object.entries(current).some(([key, value]) => value !== automatic.automatic?.[key as keyof typeof current]) };
    }),
  }));
}

export async function saveModelConnection(config: AppConfig, runtime: ModelRuntime, input: ModelConnectionInput, id?: string) {
  const document = read(config);
  const connectionId = id ?? `custom-${randomUUID()}`;
  const current = document.providers[connectionId];
  if (id && !current) throw new ApiError(404, 'model_connection_missing', t('errors.connectionMissing'));
  document.providers[connectionId] = {
    ...current, name: input.name || new URL(input.baseUrl).hostname,
    baseUrl: input.baseUrl.replace(/\/+$/, ''), api: input.api,
    // Pi uses a placeholder key to expose unauthenticated local endpoints in its model picker.
    apiKey: input.clearKey ? 'local' : input.key?.trim() || current?.apiKey || 'local',
    models: input.models.map(model => {
      const known = knownModel(runtime, model.id, input.api, connectionId);
      const previous = { ...current?.models?.find(item => item.id === model.id) };
      if (model.reset) for (const key of ['contextWindow', 'maxTokens', 'input', 'inputLimits', 'reasoning', 'thinkingLevelMap']) delete previous[key];
      return {
        ...(known ? { name: known.name, contextWindow: known.contextWindow, maxTokens: known.maxTokens,
          input: known.input, inputLimits: known.inputLimits, reasoning: known.reasoning,
          thinkingLevelMap: known.thinkingLevelMap, cost: known.cost, compat: known.compat } : {}),
        ...previous, id: model.id,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        ...(model.vision === undefined ? {} : { input: model.vision ? ['text', 'image'] : ['text'] }),
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      };
    }),
  };
  writeFileSync(path.join(config.piDir, 'models.json'), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await runtime.refresh({ allowNetwork: false, providers: [connectionId] });
}

export async function removeModelConnection(config: AppConfig, runtime: ModelRuntime, id: string) {
  const document = read(config);
  if (!document.providers[id]) throw new ApiError(404, 'model_connection_missing', t('errors.connectionMissing'));
  delete document.providers[id];
  writeFileSync(path.join(config.piDir, 'models.json'), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await runtime.refresh({ allowNetwork: false, providers: [id] });
}

export async function discoverModels(config: AppConfig, runtime: ModelRuntime, input: ModelDiscoveryInput, signal: AbortSignal) {
  let key = input.clearKey ? '' : input.key?.trim();
  if (!key && !input.clearKey && input.connectionId) {
    key = (await runtime.getAuth(input.connectionId, { signal }))?.auth.apiKey;
  } else if (!key && !input.clearKey && input.speechConnectionId) {
    const target = new SpeechConnections(config).resolve(input.speechConnectionId);
    if (target.kind === 'custom') key = target.key;
  }
  const headers: Record<string, string> = {};
  if (input.api === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01';
    if (key) headers['x-api-key'] = key;
  } else if (key) headers[input.api === 'google-generative-ai' ? 'x-goog-api-key' : 'Authorization'] =
    input.api === 'google-generative-ai' ? key : `Bearer ${key}`;
  let response: Response;
  try {
    response = await fetch(`${input.baseUrl.replace(/\/+$/, '')}/models`, {
      headers, signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeouts.modelCatalogMs)]),
    });
  } catch {
    throw new ApiError(502, 'model_discovery_failed', t('errors.discoveryNetwork'));
  }
  if (!response.ok) throw new ApiError(502, 'model_discovery_failed', t('errors.discoveryStatus', {value0: response.status}));
  const schema = input.api === 'google-generative-ai'
    ? z.object({ models: z.array(z.object({ name: z.string() })) }).transform(data => data.models.map(model => model.name.replace(/^models\//, '')))
    : z.object({ data: z.array(z.object({ id: z.string() })) }).transform(data => data.data.map(model => model.id));
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ApiError(502, 'model_catalog_invalid', t('errors.discoveryFormat'));
  return { models: [...new Set(parsed.data)].map(id => describe(id, knownModel(runtime, id, input.api, input.connectionId))) };
}
