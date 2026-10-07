import 'server-only';
import { mkdirSync } from 'node:fs';
import { readAppConfig } from './read-app-config';
import { openAppDatabase } from './open-app-database';
import { PiSessionRegistry } from './pi-session-registry';
import { recoverInterruptedRuns } from '@/features/conversations/server/conversation-run-store';
import { recoverFileImports } from '@/features/files/server/recover-file-imports';
function createRuntime() {
  const config = readAppConfig();
  for (const directory of [config.workspaceDir, config.piDir, config.stagingDir, config.importsDir]) mkdirSync(directory, { recursive: true });
  const db = openAppDatabase(config.dataDir);
  recoverInterruptedRuns(db);
  const ready = recoverFileImports(config);
  return { config, db, sessions: new PiSessionRegistry(db, config), ready };
}
type AppRuntime = ReturnType<typeof createRuntime>;
const processState = globalThis as typeof globalThis & { researchAppRuntime?: AppRuntime };
export function getAppRuntime() { return processState.researchAppRuntime ??= createRuntime(); }
