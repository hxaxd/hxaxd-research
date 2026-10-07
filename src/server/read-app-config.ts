import 'server-only';
import path from 'node:path';
export function readAppConfig() {
  const dataDir = path.resolve(/* turbopackIgnore: true */ process.env.APP_DATA_DIR || '.local');
  return { dataDir, workspaceDir: path.join(dataDir, 'workspaces'), piDir: path.join(dataDir, 'pi'), stagingDir: path.join(dataDir, 'staging'), importsDir: path.join(dataDir, 'imports') };
}
export type AppConfig = ReturnType<typeof readAppConfig>;
