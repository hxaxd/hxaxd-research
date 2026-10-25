import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

import { createTestApp } from '../app';
import { startModelServer } from '../model-server';

const execute = promisify(execFile);

test.each(['configuration', 'environment'])('native model requests use the %s proxy and bypass loopback hosts', async source => {
  const app = await createTestApp();
  const server = await startModelServer();
  const upstream = new URL(server.config.providers.test.baseUrl);
  const forwarded: string[] = [];
  const proxy = createServer((request, response) => {
    const target = new URL(request.url!);
    forwarded.push(target.hostname);
    const relay = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: target.pathname,
      method: request.method, headers: request.headers }, result => {
      response.writeHead(result.statusCode!, result.headers);
      result.pipe(response);
    });
    request.pipe(relay);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  try {
    await writeFile(app.config.configFile, JSON.stringify({ dataDir: app.config.dataDir,
      network: { proxy: source === 'configuration' ? proxyUrl : null } }));
    const configured = structuredClone(server.config);
    configured.providers.test.baseUrl = 'http://model.invalid/v1';
    const models = path.join(app.config.piDir, 'models.json');
    await writeFile(models, JSON.stringify(configured));
    const input = path.join(app.config.dataDir, 'input.json');
    const output = path.join(app.config.dataDir, 'output.json');
    await writeFile(input, JSON.stringify({ system: 'Test', prompt: 'Hello' }));
    const envProxy = source === 'environment' ? proxyUrl : 'http://127.0.0.1:1';
    const env = { ...process.env, HTTP_PROXY: envProxy, HTTPS_PROXY: envProxy,
      http_proxy: envProxy, https_proxy: envProxy, NO_PROXY: '', no_proxy: '' };
    const args = [path.resolve('src/app/models/invoke.mjs'), '--pi-dir', app.config.piDir,
      '--model', 'test/test-model', '--input', input, '--output', output];
    await execute(process.execPath, args, { env });
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ text: '测试回答' });
    expect(forwarded).toEqual(['model.invalid']);
    await writeFile(models, JSON.stringify(server.config));
    await execute(process.execPath, args, { env });
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ text: '测试回答' });
    expect(forwarded).toEqual(['model.invalid']);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await server.close();
    await app.cleanup();
  }
});

test('ChatGPT account requests use the HTTPS proxy and report upstream failure without exposing credentials', async () => {
  const app = await createTestApp();
  const destinations: string[] = [];
  const proxy = createServer();
  proxy.on('connect', (request, socket) => {
    destinations.push(request.url!);
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  try {
    await writeFile(path.join(app.config.piDir, 'auth.json'), JSON.stringify({ openai: {
      type: 'oauth', access: 'private-access', refresh: 'private-refresh', clientId: 'oaiapp_test',
      expires: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'],
    } }));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const result = await execute(process.execPath, [path.resolve('src/app/models/invoke.mjs'), '--pi-dir', app.config.piDir, '--list'], {
      env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:1', http_proxy: 'http://127.0.0.1:1',
        HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' },
    });
    const catalog = JSON.parse(result.stdout);
    expect(destinations).toContain('api.openai.com:443');
    expect(catalog.models).toEqual([]);
    expect(catalog.issues).toContainEqual(expect.objectContaining({ provider: 'openai' }));
    expect(result.stdout + result.stderr).not.toContain('private-');
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await app.cleanup();
  }
});

test('native model command uses registered providers without exposing credentials and submits all blocks together', async () => {
  const app = await createTestApp();
  const server = await startModelServer();
  try {
    await writeFile(path.join(app.config.piDir, 'models.json'), JSON.stringify(server.config));
    const command = [path.resolve('src/app/models/invoke.mjs'), '--pi-dir', app.config.piDir];
    const catalog = JSON.parse((await execute(process.execPath, [...command, '--list'])).stdout);
    expect(catalog.models.some((model: { id: string }) => model.id === 'test/test-model')).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain('test-only-key');
    const selected = JSON.parse((await execute(process.execPath, [...command, '--list', '--model', 'test/test-model'])).stdout);
    expect(selected.models).toEqual([expect.objectContaining({ id: 'test/test-model', thinkingLevels: ['off'] })]);
    await expect(execute(process.execPath, [...command, '--list', '--model', 'test/missing'])).rejects.toThrow('模型不可用');
    const input = path.join(app.config.dataDir, 'request.json');
    const output = path.join(app.config.dataDir, 'response.json');
    await writeFile(input, JSON.stringify({ system: 'Translate all blocks into Chinese.', prompt: JSON.stringify({
      instructions: '[TRANSLATE]', blocks: Array.from({ length: 100 }, (_, index) => ({ id: `b${index}`, text: `Paragraph ${index}`, preserve: false })),
    }) }));
    await execute(process.execPath, [...command, '--model', 'test/test-model', '--input', input, '--output', output]);
    const response = JSON.parse(await readFile(output, 'utf8'));
    const translated = JSON.parse(response.text);
    expect(translated.blocks).toHaveLength(100);
    expect(translated.blocks[99]).toEqual({ id: 'b99', text: '译文：Paragraph 99' });
    expect(JSON.stringify(response)).not.toContain('test-only-key');
  } finally {
    await server.close();
    await app.cleanup();
  }
});
