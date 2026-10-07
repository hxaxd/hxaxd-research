import 'server-only';
import { readdir } from 'node:fs/promises';
import type { AppConfig } from '@/server/read-app-config';
import { readImportReceipt, removeImportStaging, saveImportReceipt, verifyImportFiles } from './import-workspace-files';
import { resolveWorkspacePath } from './resolve-workspace-path';
export async function recoverFileImports(config: AppConfig) {
  for (const entry of await readdir(config.importsDir)) {
    if (!entry.endsWith('.json')) continue;
    const receipt = await readImportReceipt(config, entry.slice(0, -5));
    if (!receipt || receipt.state !== 'ready') continue;
    const target = await resolveWorkspacePath(config.workspaceDir, receipt.workspaceId, receipt.finalPath, true);
    const single = receipt.manifest.length === 1 && !receipt.folderName && !receipt.manifest[0].path.includes('/');
    receipt.state = await verifyImportFiles(target, receipt.manifest, single) ? 'committed' : 'failed';
    await saveImportReceipt(config, receipt);
  }
  for (const entry of await readdir(config.stagingDir)) {
    if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(entry)) await removeImportStaging(config, entry);
  }
}
