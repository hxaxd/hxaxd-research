import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { isWithin } from '../src/features/files/server/paths';
import { createWorkspace } from '../src/features/workspaces/server/workspaces';
import { readAppConfig } from '../src/server/config';

export async function createTestApp() {
  const testRoot = path.resolve('.runtime/dev', 'tests');
  const dataDir = path.join(testRoot, randomUUID());
  const previous = process.env.APP_DATA_DIR;
  process.env.APP_DATA_DIR = dataDir;
  const config = readAppConfig();
  if (previous === undefined) delete process.env.APP_DATA_DIR;
  else process.env.APP_DATA_DIR = previous;
  for (const directory of [config.workspaceDir, config.piDir, config.stagingDir])
    await mkdir(directory, { recursive: true });
  const workspace = createWorkspace(config.workspaceDir, { id: randomUUID(), name: '测试工作区' });
  return {
    config,
    workspace,
    async cleanup() {
      if (!isWithin(testRoot, path.resolve(dataDir)) || path.resolve(dataDir) === testRoot)
        throw new Error('Invalid test cleanup path');
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
