// Shared by the Node server and native environment setup commands.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import stripJsonComments from 'strip-json-comments';
import { z } from 'zod';

const positive = z.number().int().positive();
const directory = z.string().min(1);
const configuration = z.strictObject({
  dataDir: directory.default('.runtime/data'),
  envDir: directory.default('.runtime/env'),
  tempDir: directory.default('.runtime/temp'),
  templateDir: directory.default('.runtime/templates'),
  network: z.strictObject({
    proxy: z.url({ protocol: /^https?$/ }).nullable().default(null),
    noProxy: z.string().default('localhost,127.0.0.1,::1'),
  }).prefault({}),
  files: z.strictObject({
    uploadFileBytes: positive.default(256 * 1024 * 1024),
    uploadTotalBytes: positive.default(1024 * 1024 * 1024),
    uploadFiles: positive.default(1000),
    textBytes: positive.default(16 * 1024 * 1024),
    previewBytes: positive.default(100000),
    pdfBytes: positive.default(256 * 1024 * 1024),
    pdfPages: positive.default(20),
    pdfPageCharacters: positive.default(60000),
    audioBytes: positive.default(40_000_000),
  }).prefault({}),
  timeouts: z.strictObject({
    modelCatalogMs: positive.default(15000),
    speechSecretMs: positive.default(20000),
    speechRealtimeMs: positive.default(30000),
    speechTranscriptionMs: positive.default(120000),
    speechProbeMs: positive.default(10000),
  }).prefault({}),
  agent: z.strictObject({
    retryEnabled: z.boolean().default(true),
    maxRetries: z.number().int().nonnegative().default(2),
  }).prefault({}),
  events: z.strictObject({
    heartbeatMs: positive.default(15000),
    conversationBatchMs: positive.default(30),
    fileBatchMs: positive.default(100),
  }).prefault({}),
  ocr: z.strictObject({
    distro: z.string().min(1).default('Ubuntu'),
    device: z.string().regex(/^(cpu|gpu:\d+)$/).default('gpu:0'),
  }).prefault({}),
  translation: z.strictObject({
    modelsCommand: z.array(z.string()).min(1).optional(),
  }).prefault({}),
});

function configPath(root) {
  return path.resolve(root, process.env.APP_CONFIG_FILE || '.runtime/config.jsonc');
}

export function initializeConfig(root) {
  const configFile = configPath(root);
  if (!existsSync(/* turbopackIgnore: true */ configFile)) {
    mkdirSync(path.dirname(configFile), { recursive: true });
    copyFileSync(new URL('../../config.default.jsonc', import.meta.url), configFile);
    console.log(`Created ${configFile}`);
  }
}

export function readAppConfig(root = process.cwd()) {
  const configFile = configPath(root);
  const config = configuration.parse(existsSync(/* turbopackIgnore: true */ configFile)
    ? JSON.parse(stripJsonComments(readFileSync(/* turbopackIgnore: true */ configFile, 'utf8').replace(/^\uFEFF/, ''))) : {});
  const dataDir = path.resolve(root, config.dataDir);
  const envDir = path.resolve(root, config.envDir);
  return {
    ...config,
    configFile,
    dataDir,
    envDir,
    templateDir: path.resolve(root, config.templateDir),
    workspaceDir: path.join(dataDir, 'workspaces'),
    piDir: path.join(dataDir, 'pi'),
    stagingDir: path.resolve(root, config.tempDir),
    texDir: path.join(envDir, 'tex'),
    ocrDir: path.join(envDir, 'ocr'),
    translationDir: path.join(envDir, 'translation'),
    translation: {
      modelsCommand: config.translation.modelsCommand ?? [process.execPath,
        path.resolve(root, 'src/app/models/invoke.mjs'), '--pi-dir', path.join(dataDir, 'pi')],
    },
  };
}

/** @typedef {ReturnType<typeof readAppConfig>} AppConfig */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  if (process.argv.includes('--init')) {
    initializeConfig(root);
  } else {
    console.log(JSON.stringify(process.argv.includes('--defaults') ? configuration.parse({}) : readAppConfig(root), null, 2));
  }
}
