import 'server-only';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '@/app/config.mjs';

export function translationContext(config: AppConfig) {
  const python = path.join(config.translationDir, 'python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const installationPath = path.join(config.ocrDir, 'installation.json');
  const installation = existsSync(installationPath)
    ? z.object({ model: z.string(), command: z.array(z.string()).min(1) }).parse(JSON.parse(readFileSync(installationPath, 'utf8')))
    : null;
  return {
    root: config.translationDir,
    templates: path.join(config.templateDir, 'app/translation'),
    command: [python, path.resolve('src/app/translation/pipeline.py')],
    configured: existsSync(python),
    setupCommand: [process.execPath, path.resolve('src/app/translation/setup.mjs')],
    ocr: { model: installation?.model ?? 'PaddleOCR-VL-1.6', root: config.ocrDir,
      configured: installation !== null, command: installation?.command,
      setupCommand: [process.execPath, path.resolve('src/app/ocr/setup.mjs')] },
    modelsCommand: config.translation.modelsCommand,
  };
}
