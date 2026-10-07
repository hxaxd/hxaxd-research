import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { readAppConfig } from '../src/server/read-app-config';
import { openAppDatabase } from '../src/server/open-app-database';
import { createWorkspace } from '../src/features/workspaces/server/create-workspace';
import { isWithin } from '../src/features/files/server/resolve-workspace-path';
export async function createTestApp() {
  const testRoot = path.resolve('.tools', 'tests');
  const dataDir = path.join(testRoot, randomUUID());
  const previous = process.env.APP_DATA_DIR;
  process.env.APP_DATA_DIR = dataDir;
  const config = readAppConfig();
  if (previous === undefined) delete process.env.APP_DATA_DIR; else process.env.APP_DATA_DIR = previous;
  for (const directory of [config.workspaceDir, config.piDir, config.stagingDir, config.importsDir]) await mkdir(directory, { recursive: true });
  const db = openAppDatabase(dataDir);
  const workspace = createWorkspace(db, config.workspaceDir, { id: randomUUID(), name: '测试工作区' });
  return { config, db, workspace, async cleanup() {
    db.close();
    if (!isWithin(testRoot, path.resolve(dataDir)) || path.resolve(dataDir) === testRoot) throw new Error('Invalid test cleanup path');
    await rm(dataDir, { recursive: true, force: true });
  } };
}
