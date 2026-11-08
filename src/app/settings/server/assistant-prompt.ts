import 'server-only';

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function readAssistantPrompt(dataDir: string) {
  try {
    return readFileSync(/* turbopackIgnore: true */ path.join(dataDir, 'assistant-prompt.md'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export function writeAssistantPrompt(dataDir: string, prompt: string) {
  writeFileSync(path.join(dataDir, 'assistant-prompt.md'), prompt, 'utf8');
}
