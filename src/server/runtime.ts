import 'server-only';

import { mkdirSync } from 'node:fs';

import { PiSessionRegistry } from '@/features/conversations/server/session-registry';
import { ModelProviders } from '@/features/models/server/providers';
import { ReaderController } from '@/features/files/server/reader';
import { Speech } from '@/features/speech/server/speech';

import { readAppConfig } from './config.mjs';

function createRuntime() {
  const config = readAppConfig();
  for (const directory of [config.workspaceDir, config.piDir, config.stagingDir])
    mkdirSync(directory, { recursive: true });
  const models = new ModelProviders(config);
  const reader = new ReaderController();
  const speech = new Speech(config, models);
  return { config, models, speech, reader, sessions: new PiSessionRegistry(config, models, reader) };
}
type AppRuntime = ReturnType<typeof createRuntime>;
const processState = globalThis as typeof globalThis & { researchAppRuntime?: AppRuntime };

export function getAppRuntime() {
  return (processState.researchAppRuntime ??= createRuntime());
}
