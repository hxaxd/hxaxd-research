import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execute = promisify(execFile);

test('installation creates the annotated runtime configuration and preserves existing settings', async () => {
  await mkdir(path.resolve('.runtime/dev'), { recursive: true });
  const root = await mkdtemp(path.resolve('.runtime/dev/config-install-'));
  const app = path.join(root, 'src/app');
  const command = path.join(app, 'config.mjs');
  const template = path.resolve('config.default.jsonc');
  const env = { ...process.env, APP_CONFIG_FILE: '' };
  try {
    await mkdir(app, { recursive: true });
    await copyFile(path.resolve('src/app/config.mjs'), command);
    await copyFile(template, path.join(root, 'config.default.jsonc'));
    await execute(process.execPath, [command, '--init'], { env });
    const target = path.join(root, '.runtime/config.jsonc');
    expect(await readFile(target, 'utf8')).toBe(await readFile(template, 'utf8'));
    const loaded = JSON.parse((await execute(process.execPath, [command], { env })).stdout);
    expect(loaded.dataDir).toBe(path.join(root, '.runtime/data'));
    const custom = '// User settings\n{"agent":{"maxRetries":0}}';
    await writeFile(target, custom);
    await execute(process.execPath, [command, '--init'], { env });
    expect(await readFile(target, 'utf8')).toBe(custom);
    const alternate = path.join(root, 'custom/settings.jsonc');
    const alternateEnv = { ...env, APP_CONFIG_FILE: alternate };
    await execute(process.execPath, [command, '--init'], { env: alternateEnv });
    expect(await readFile(alternate, 'utf8')).toBe(await readFile(template, 'utf8'));
    await writeFile(alternate, '{unfinished');
    await execute(process.execPath, [command, '--init'], { env: alternateEnv });
    expect(await readFile(alternate, 'utf8')).toBe('{unfinished');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resource installation updates runtime templates while preserving personal configuration', async () => {
  await mkdir(path.resolve('.runtime/dev'), { recursive: true });
  const root = await mkdtemp(path.resolve('.runtime/dev/template-install-'));
  const file = path.join(root, 'config.jsonc');
  const templateDir = path.join(root, 'templates');
  const personal = '// Personal configuration\n' + JSON.stringify({ templateDir, agent: { maxRetries: 0 } });
  const env = { ...process.env, APP_CONFIG_FILE: file };
  const command = path.resolve('src/app/install.mjs');
  try {
    await writeFile(file, personal);
    await execute(process.execPath, [command], { env });
    const skill = path.join(templateDir, 'app/settings/skills/workbench-guide/SKILL.md');
    const source = path.resolve('src/app/settings/skills/workbench-guide/SKILL.md');
    expect(await readFile(skill, 'utf8')).toBe(await readFile(source, 'utf8'));
    const html = path.join(templateDir, 'app/translation/skills/paper-translation/assets/paper.html');
    expect(await readFile(html, 'utf8')).toBe(await readFile('src/app/translation/skills/paper-translation/assets/paper.html', 'utf8'));
    await writeFile(skill, 'temporary runtime change');
    await execute(process.execPath, [command], { env });
    expect(await readFile(skill, 'utf8')).toBe(await readFile(source, 'utf8'));
    expect(await readFile(file, 'utf8')).toBe(personal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native configuration command resolves custom paths, preserves defaults and rejects invalid configuration', async () => {
  await mkdir(path.resolve('.runtime/dev'), { recursive: true });
  const root = await mkdtemp(path.resolve('.runtime/dev/config-'));
  const file = path.join(root, 'config.json');
  const command = path.resolve('src/app/config.mjs');
  const env = { ...process.env, APP_CONFIG_FILE: file };
  const configuration = { dataDir: path.join(root, 'data'), envDir: path.relative(process.cwd(), path.join(root, 'env')),
    tempDir: path.join(root, 'temp'), agent: { maxRetries: 0 } };
  try {
    await writeFile(file, '\uFEFF// Application configuration\n' + JSON.stringify(configuration));
    const resolved = JSON.parse((await execute(process.execPath, [command], { env, cwd: root })).stdout);
    expect(resolved).toMatchObject({ dataDir: configuration.dataDir, stagingDir: configuration.tempDir,
      texDir: path.resolve(configuration.envDir, 'tex'), ocrDir: path.resolve(configuration.envDir, 'ocr'),
      translationDir: path.resolve(configuration.envDir, 'translation'), agent: { retryEnabled: true, maxRetries: 0 } });
    for (const invalid of [{ files: { audioBytes: -1 } }, { envDr: 'misspelled' }, { ocr: { device: 'cuda:0' } }]) {
      await writeFile(file, JSON.stringify(invalid));
      await expect(execute(process.execPath, [command], { env })).rejects.toThrow();
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(invalid);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the annotated default template loads and JSON comments preserve literal command arguments', async () => {
  const command = path.resolve('src/app/config.mjs');
  const example = path.resolve('config.default.jsonc');
  const env = { ...process.env, APP_CONFIG_FILE: example };
  const loaded = JSON.parse((await execute(process.execPath, [command], { env })).stdout);
  expect(loaded).toMatchObject({ files: { uploadFiles: 1000 }, ocr: { device: 'gpu:0' } });
  expect(loaded.translation.modelsCommand).toContain('--pi-dir');
  await mkdir(path.resolve('.runtime/dev'), { recursive: true });
  const root = await mkdtemp(path.resolve('.runtime/dev/config-comments-'));
  const file = path.join(root, 'config.jsonc');
  const args = ['custom-program', 'https://example.com/v1', 'literal/*not a comment*/'];
  try {
    await writeFile(file, '/* Command override */\n' + JSON.stringify({ translation: { modelsCommand: args } }));
    const resolved = JSON.parse((await execute(process.execPath, [command], { env: { ...env, APP_CONFIG_FILE: file } })).stdout);
    expect(resolved.translation.modelsCommand).toEqual(args);
    await writeFile(file, '// Incomplete edit\n{"files":');
    await expect(execute(process.execPath, [command], { env: { ...env, APP_CONFIG_FILE: file } })).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('// Incomplete edit\n{"files":');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
