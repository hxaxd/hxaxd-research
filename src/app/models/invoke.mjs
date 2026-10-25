import { text as t } from '../i18n/server.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createModelRuntime, modelCatalog, resolveModel, thinkingLevels } from './runtime.mjs';
import { readAppConfig } from '../config.mjs';
import { configureNetwork } from '../network.mjs';
import { z } from 'zod';

const requestSchema = z.object({
  system: z.string(),
  prompt: z.string(),
  thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  maxTokens: z.number().int().positive().optional(),
});

function describeModel(model) {
  return { id: `${model.provider}/${model.id}`, name: model.name,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingLevels: thinkingLevels(model) };
}

async function invokeModel(runtime, id, request, signal, timeoutMs) {
  const input = requestSchema.parse(request);
  const model = await resolveModel(runtime, id, signal, timeoutMs);
  const result = await runtime.completeSimple(model, {
    systemPrompt: input.system,
    messages: [{ role: 'user', content: input.prompt, timestamp: Date.now() }],
  }, { signal, maxTokens: input.maxTokens ?? model.maxTokens, reasoning: input.thinkingLevel });
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
  const config = readAppConfig();
  configureNetwork(config.network);
  const timeoutMs = config.timeouts.modelCatalogMs;
  if (!values['pi-dir']) throw new Error(t('errors.piDirectory'));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const runtime = await createModelRuntime(values['pi-dir'], controller.signal);
  if (values.list) {
    const catalog = values.model
      ? { models: [describeModel(await resolveModel(runtime, values.model, controller.signal, timeoutMs))], issues: [] }
      : await modelCatalog(runtime, controller.signal, timeoutMs).then(catalog => ({ ...catalog, models: catalog.models.map(describeModel) }));
    console.log(JSON.stringify(catalog));
    return;
  }
  if (!values.model || !values.input || !values.output)
    throw new Error(t('errors.modelArguments'));
  const result = await invokeModel(runtime, values.model,
    JSON.parse(await readFile(values.input, 'utf8')), controller.signal, timeoutMs);
  await writeFile(values.output, JSON.stringify(result, null, 2));
  if (['error', 'aborted', 'length'].includes(result.stopReason))
    throw new Error(t('errors.modelIncomplete', {value0: result.stopReason, value1: result.error ?? '', value2: values.output}));
  console.log(JSON.stringify({ output: values.output, stopReason: result.stopReason, usage: result.usage }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
