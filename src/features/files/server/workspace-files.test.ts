import { afterEach, beforeEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp } from '../../../../tests/create-test-app';
import { pdfFixture } from '../../../../tests/pdf-fixture';
import { resolveWorkspacePath } from './resolve-workspace-path';
import { listWorkspaceFiles } from './list-workspace-files';
import { readWorkspaceText } from './read-workspace-file';
import { writeWorkspaceText, editWorkspaceText } from './write-workspace-text';
import { extractPdfText } from './extract-pdf-text';
import { importWorkspaceFiles, saveImportReceipt } from './import-workspace-files';
import { recoverFileImports } from './recover-file-imports';
import { serveWorkspaceFile } from './serve-workspace-file';
let app: Awaited<ReturnType<typeof createTestApp>>;
beforeEach(async () => { app = await createTestApp(); });
afterEach(async () => { await app.cleanup(); });
function upload(id: string, files: [string, string][], folderName?: string) {
  const form = new FormData(); form.append('metadata', JSON.stringify({ requestId: id, target: '', folderName }));
  for (const [name, content] of files) form.append('files', new Blob([content]), name);
  return new Request('http://localhost/imports', { method: 'POST', body: form });
}
test('external files are visible; traversal and an external junction are rejected', async () => {
  const root = path.join(app.config.workspaceDir, app.workspace.id);
  await writeFile(path.join(root, 'external.txt'), 'external');
  expect((await listWorkspaceFiles(app.config.workspaceDir, app.workspace.id)).map(file => file.name)).toContain('external.txt');
  await symlink(app.config.piDir, path.join(root, 'escape'), 'junction');
  for (const candidate of ['../app.sqlite', 'C:\\secret', 'escape/auth.json', 'a:stream', 'NUL.txt']) await expect(resolveWorkspacePath(app.config.workspaceDir, app.workspace.id, candidate, true)).rejects.toThrow();
});
test('edits require the read version and cancellation cannot modify a file', async () => {
  const written = await writeWorkspaceText(app.config.workspaceDir, app.workspace.id, 'note.txt', 'alpha');
  await expect(writeWorkspaceText(app.config.workspaceDir, app.workspace.id, 'note.txt', 'wrong')).rejects.toThrow();
  const edited = await editWorkspaceText(app.config.workspaceDir, app.workspace.id, 'note.txt', 'alpha', 'beta', written.hash);
  expect((await readWorkspaceText(app.config.workspaceDir, app.workspace.id, 'note.txt')).text).toBe('beta');
  await expect(writeWorkspaceText(app.config.workspaceDir, app.workspace.id, 'note.txt', 'lost', written.hash)).rejects.toThrow();
  await expect(writeWorkspaceText(app.config.workspaceDir, app.workspace.id, 'note.txt', 'cancelled', edited.hash, AbortSignal.abort())).rejects.toThrow();
  expect(await readFile(path.join(app.config.workspaceDir, app.workspace.id, 'note.txt'), 'utf8')).toBe('beta');
});
test('directory imports preserve TeX paths, retry without duplication, and resolve name conflicts', async () => {
  const id = randomUUID(), files: [string, string][] = [['main.tex', '\\input{sections/body.tex}'], ['sections/body.tex', 'alpha']];
  const result = await importWorkspaceFiles(app.config, app.workspace.id, upload(id, files, 'source'));
  expect(await readFile(path.join(app.config.workspaceDir, app.workspace.id, result.path, 'sections/body.tex'), 'utf8')).toBe('alpha');
  expect((await importWorkspaceFiles(app.config, app.workspace.id, upload(id, files, 'source'))).duplicate).toBe(true);
  await expect(importWorkspaceFiles(app.config, app.workspace.id, upload(id, [['main.tex', 'different']], 'source'))).rejects.toThrow();
  const other = await importWorkspaceFiles(app.config, app.workspace.id, upload(randomUUID(), [['main.tex', 'different']], 'source'));
  expect(other.path).toBe('source (1)');
});
test('an invalid batch leaves no final files and committed files recover after receipt failure', async () => {
  await expect(importWorkspaceFiles(app.config, app.workspace.id, upload(randomUUID(), [['safe.txt', 'safe'], ['../escape.txt', 'invalid']], 'batch'))).rejects.toThrow();
  expect(await listWorkspaceFiles(app.config.workspaceDir, app.workspace.id)).toEqual([]);
  const id = randomUUID();
  const file = await writeWorkspaceText(app.config.workspaceDir, app.workspace.id, 'done.txt', 'done');
  await saveImportReceipt(app.config, { requestId: id, target: '', workspaceId: app.workspace.id, finalPath: 'done.txt', manifest: [{ path: 'done.txt', hash: file.hash, bytes: 4 }], state: 'ready', result: { requestId: id, path: 'done.txt', bytes: 4, files: 1, duplicate: false } });
  await mkdir(path.join(app.config.stagingDir, id));
  await recoverFileImports(app.config);
  expect(JSON.parse(await readFile(path.join(app.config.importsDir, `${id}.json`), 'utf8')).state).toBe('committed');
  expect(await readFile(path.join(app.config.workspaceDir, app.workspace.id, 'done.txt'), 'utf8')).toBe('done');
});
test('PDF extraction returns actual text and byte-range responses match stored bytes', async () => {
  const bytes = pdfFixture(); await writeFile(path.join(app.config.workspaceDir, app.workspace.id, 'paper.pdf'), bytes);
  const result = await extractPdfText(app.config.workspaceDir, app.workspace.id, 'paper.pdf', 1, 1);
  expect(result.pages[0].text).toContain('Research fixture'); expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  const response = await serveWorkspaceFile(new Request('http://localhost/file?path=paper.pdf', { headers: { Range: 'bytes=0-9' } }), app.config.workspaceDir, app.workspace.id);
  expect(response.status).toBe(206); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(0, 10));
});
