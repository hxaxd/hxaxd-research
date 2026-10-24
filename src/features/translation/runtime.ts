import 'server-only';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const configuration = z.object({
  ocrRoot: z.string(),
  modelsCommand: z.array(z.string()).min(1), texRoot: z.string(), katex: z.string(),
});

export function translationContext(dataDir: string) {
  const configPath = path.join(dataDir, 'translation.json');
  const configured = existsSync(configPath);
  const config = configured ? configuration.parse(JSON.parse(readFileSync(configPath, 'utf8'))) : null;
  const ocrRoot = config?.ocrRoot ?? path.resolve(/* turbopackIgnore: true */ '.runtime/env/ocr');
  const installationPath = path.join(ocrRoot, 'installation.json');
  const installation = existsSync(installationPath)
    ? z.object({ model: z.string(), command: z.array(z.string()).min(1) }).parse(JSON.parse(readFileSync(installationPath, 'utf8')))
    : null;
  return {
    command: [path.resolve('.runtime/env/translation/python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
      path.resolve('src/features/translation/pipeline.py'), '--config', configPath],
    configured,
    setupCommand: [process.execPath, path.resolve('src/features/translation/setup.mjs')],
    ocr: { model: installation?.model ?? 'PaddleOCR-VL-1.6', root: ocrRoot,
      configured: installation !== null,
      command: installation?.command,
      setupCommand: [process.execPath, path.resolve('src/features/ocr/setup.mjs')] },
    modelsCommand: config?.modelsCommand ?? [process.execPath, path.resolve('src/features/models/invoke.mjs'), '--pi-dir', path.join(dataDir, 'pi')],
  };
}
