import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';

const requestSchema = z.object({
  system: z.string(),
  prompt: z.string(),
  maxTokens: z.number().int().positive().optional(),
});

function describeModel(model) {
  return { id: `${model.provider}/${model.id}`, name: model.name,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens };
}

async function resolveModel(runtime, id, signal) {
  const models = await runtime.getAvailable(id.slice(0, id.indexOf('/')), { signal });
  const model = models.find(model => `${model.provider}/${model.id}` === id);
  if (!model) throw new Error(`模型不可用：${id}`);
  return model;
}

async function listModels(runtime, signal) {
  const results = await Promise.all(runtime.getProviders()
    .filter(provider => runtime.hasConfiguredAuth(provider.id))
    .map(async provider => {
      try {
        const models = await runtime.getAvailable(provider.id, { signal });
        return { models: models.map(describeModel), issues: [] };
      } catch (error) {
        return { models: [], issues: [{ provider: provider.id, message: error.message }] };
      }
    }));
  const configurationError = runtime.getError();
  return { models: results.flatMap(result => result.models), issues: [
    ...(configurationError ? [{ provider: 'configuration', message: configurationError }] : []),
    ...results.flatMap(result => result.issues),
  ] };
}

async function invokeModel(runtime, id, request, signal) {
  const input = requestSchema.parse(request);
  const model = await resolveModel(runtime, id, signal);
  const result = await runtime.completeSimple(model, {
    systemPrompt: input.system,
    messages: [{ role: 'user', content: input.prompt, timestamp: Date.now() }],
  }, { signal, maxTokens: input.maxTokens ?? model.maxTokens });
  return {
    text: result.content.filter(part => part.type === 'text').map(part => part.text).join(''),
    stopReason: result.stopReason, error: result.errorMessage, usage: result.usage,
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    'pi-dir': { type: 'string' }, list: { type: 'boolean' },
    model: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' },
  } });
  if (!values['pi-dir']) throw new Error('请提供 --pi-dir');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const runtime = await ModelRuntime.create({
    authPath: path.join(values['pi-dir'], 'auth.json'),
    modelsPath: path.join(values['pi-dir'], 'models.json'),
    signal: controller.signal,
  });
  if (values.list) {
    const catalog = values.model
      ? { models: [describeModel(await resolveModel(runtime, values.model, controller.signal))], issues: [] }
      : await listModels(runtime, controller.signal);
    console.log(JSON.stringify(catalog));
    return;
  }
  if (!values.model || !values.input || !values.output)
    throw new Error('请提供 --model、--input 和 --output，或使用 --list');
  const result = await invokeModel(runtime, values.model,
    JSON.parse(await readFile(values.input, 'utf8')), controller.signal);
  await writeFile(values.output, JSON.stringify(result, null, 2));
  if (['error', 'aborted', 'length'].includes(result.stopReason))
    throw new Error(`模型请求未完整完成（${result.stopReason}）：${result.error ?? ''}。已保存响应：${values.output}`);
  console.log(JSON.stringify({ output: values.output, stopReason: result.stopReason, usage: result.usage }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
