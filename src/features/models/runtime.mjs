import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';

const catalogSchema = z.object({ models: z.array(z.object({
  slug: z.string(), display_name: z.string(), visibility: z.string(),
})) });

export class ModelAccessError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** @param {string} piDir @param {AbortSignal} [signal] */
export async function createModelRuntime(piDir, signal) {
  const runtime = await ModelRuntime.create({
    authPath: path.join(piDir, 'auth.json'), modelsPath: path.join(piDir, 'models.json'), signal,
  });
  const openai = runtime.getProvider('openai');
  const oauth = openai.auth.oauth;
  runtime.registerNativeProvider({ ...openai, auth: { ...openai.auth, oauth: {
    ...oauth,
    async refresh(credential, signal) {
      return { ...credential, ...(await oauth.refresh(credential, signal)) };
    },
  } } });
  return runtime;
}

/** @param {ModelRuntime} runtime @param {string} provider @param {AbortSignal} [signal] */
async function availableModels(runtime, provider, signal, timeoutMs = 15000) {
  const models = [...await runtime.getAvailable(provider, { signal })];
  if (provider !== 'openai' || !runtime.isUsingSubscription(provider)) return models;
  const auth = await runtime.getAuth(provider, { signal });
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${auth.auth.apiKey}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new ModelAccessError(502, 'model_catalog_failed', `ChatGPT 模型列表获取失败（${response.status}），请重新连接后重试`);
  const catalog = catalogSchema.safeParse(await response.json());
  if (!catalog.success) throw new ModelAccessError(502, 'model_catalog_invalid', 'ChatGPT 返回的模型列表格式无效');
  const known = new Map(models.map(model => [model.id, model]));
  return catalog.data.models.flatMap(entry => {
    const model = known.get(entry.slug);
    return entry.visibility === 'list' && model ? [{ ...model, name: entry.display_name }] : [];
  });
}

/** @param {ModelRuntime} runtime @param {string} id @param {AbortSignal} [signal] */
export async function resolveModel(runtime, id, signal, timeoutMs = 15000) {
  const models = await availableModels(runtime, id.slice(0, id.indexOf('/')), signal, timeoutMs);
  const model = models.find(model => `${model.provider}/${model.id}` === id);
  if (!model) throw new ModelAccessError(503, 'model_unavailable', `模型不可用：${id}`);
  return model;
}

/** @param {ModelRuntime} runtime @param {AbortSignal} [signal] */
export async function modelCatalog(runtime, signal, timeoutMs = 15000) {
  const results = await Promise.all(runtime.getProviders()
    .filter(provider => runtime.hasConfiguredAuth(provider.id))
    .map(async provider => {
      try { return { models: await availableModels(runtime, provider.id, signal, timeoutMs), issues: [] }; }
      catch (error) { return { models: [], issues: [{ provider: provider.id, message: error.message }] }; }
    }));
  const error = runtime.getError();
  return { models: results.flatMap(result => result.models), issues: [
    ...(error ? [{ provider: 'configuration', message: error }] : []),
    ...results.flatMap(result => result.issues),
  ] };
}

/** @param {ReturnType<ModelRuntime['getModels']>[number]} model */
export function thinkingLevels(model) {
  if (!model.reasoning) return ['off'];
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter(level => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && (!['xhigh', 'max'].includes(level) || mapped !== undefined);
  });
}
