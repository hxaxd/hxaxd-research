import 'server-only';
import { stat } from 'node:fs/promises';
import type { MaterialReference } from '@/features/files/file-schema';
import { resolveWorkspacePath } from '@/features/files/server/resolve-workspace-path';
import { hashFile } from '@/features/files/server/read-workspace-file';
import { ApiError } from '@/shared/http/api-error';
export async function buildMaterialContext(root: string, workspaceId: string, text: string, materials: MaterialReference[]) {
  const references: string[] = [];
  const versions = new Map<string, string>();
  for (const material of materials) {
    const target = await resolveWorkspacePath(root, workspaceId, material.path);
    if (!(await stat(target)).isFile()) throw new ApiError(400, 'invalid_file', '只能引用文件，请选择具体材料');
    const hash = await hashFile(target);
    if (material.hash && material.hash !== hash) throw new ApiError(409, 'material_changed', '引用材料已变化，请重新加入对话');
    versions.set(material.path, hash);
    references.push(JSON.stringify({ path: material.path, sha256: hash }));
  }
  return { prompt: references.length ? `${text}\n\n<research-workbench-materials>\n请通过工具读取以下材料，并核验内容版本。\n${references.join('\n')}\n</research-workbench-materials>` : text, versions };
}
