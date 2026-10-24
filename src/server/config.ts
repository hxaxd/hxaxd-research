import 'server-only';

import path from 'node:path';

export function readAppConfig() {
  const dataDir = path.resolve(/* turbopackIgnore: true */ process.env.APP_DATA_DIR || '.runtime/data');
  return {
    dataDir,
    workspaceDir: path.join(dataDir, 'workspaces'),
    piDir: path.join(dataDir, 'pi'),
    stagingDir: path.resolve(/* turbopackIgnore: true */ '.runtime/temp'),
  };
}
export type AppConfig = ReturnType<typeof readAppConfig>;
