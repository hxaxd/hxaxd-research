import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

import { createTestApp } from '../app';
import { startModelServer } from '../model-server';

const execute = promisify(execFile);

test('native model command uses registered providers without exposing credentials and submits all blocks together', async () => {
  const app = await createTestApp();
  const server = await startModelServer();
  try {
    await writeFile(path.join(app.config.piDir, 'models.json'), JSON.stringify(server.config));
    const command = [path.resolve('src/features/models/invoke.mjs'), '--pi-dir', app.config.piDir];
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
