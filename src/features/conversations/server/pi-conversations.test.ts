import { afterEach, beforeEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp } from '../../../../tests/create-test-app';
import { startModelServer } from '../../../../tests/model-server';
import { PiSessionRegistry } from '@/server/pi-session-registry';
import { createConversation } from './create-conversation';
import { sendConversationMessage } from './send-conversation-message';
import { latestRun, acceptRun, recoverInterruptedRuns } from './conversation-run-store';
import { readConversationHistory } from './read-conversation-history';
import { streamConversationEvents } from './stream-conversation-events';
let app: Awaited<ReturnType<typeof createTestApp>>, model: Awaited<ReturnType<typeof startModelServer>>, sessions: PiSessionRegistry;
let conversationId: string;
beforeEach(async () => {
  app = await createTestApp(); model = await startModelServer();
  await writeFile(path.join(app.config.piDir, 'models.json'), JSON.stringify(model.config));
  sessions = new PiSessionRegistry(app.db, app.config);
  conversationId = createConversation(app.db, app.workspace.id, { id: randomUUID(), name: '对话' }).id;
});
afterEach(async () => { const run = latestRun(app.db, conversationId); if (run) await sessions.stop(app.workspace.id, conversationId, run.id); await model.close(); await app.cleanup(); });
async function send(text: string, id = randomUUID()) { return sendConversationMessage(app.db, sessions, app.config.workspaceDir, app.workspace.id, conversationId, { id, text, model: 'test/test-model', materials: [] }); }
async function waitTerminal() { await expect.poll(() => latestRun(app.db, conversationId)?.status).not.toBe('accepted'); await expect.poll(() => latestRun(app.db, conversationId)?.status).not.toBe('running'); }
test('the real Pi SDK executes file tools and persists history without duplicating a request', async () => {
  await writeFile(path.join(app.config.workspaceDir, app.workspace.id, 'note.txt'), 'alpha');
  const id = randomUUID(); await send('[EDIT]', id); await waitTerminal();
  expect(latestRun(app.db, conversationId)?.status).toBe('completed');
  expect(await readFile(path.join(app.config.workspaceDir, app.workspace.id, 'note.txt'), 'utf8')).toBe('beta');
  expect(readConversationHistory(app.db, app.config, app.workspace.id, conversationId).filter(message => message.role === 'tool')).toHaveLength(2);
  const calls = model.calls; await send('[EDIT]', id); expect(model.calls).toBe(calls);
  await expect(send('other text', id)).rejects.toThrow();
});
test('disconnecting SSE does not cancel; explicit stop cancels a slow response and busy requests are rejected', async () => {
  const run = await send('[SLOW]');
  const events = streamConversationEvents(new Request('http://localhost/events'), sessions, app.workspace.id, conversationId);
  const reader = events.body!.getReader(); await reader.read(); await reader.cancel();
  await expect.poll(() => latestRun(app.db, conversationId)?.status).toBe('running');
  await expect(send('competing')).rejects.toThrow('正在回答');
  await sessions.stop(app.workspace.id, conversationId, run.id);
  expect(latestRun(app.db, conversationId)?.status).toBe('cancelled');
  await sessions.stop(app.workspace.id, conversationId, run.id);
  expect(latestRun(app.db, conversationId)?.status).toBe('cancelled');
});
test('stop during initialization never starts a model request and restart does not replay accepted work', async () => {
  const run = await send('initializing'); await sessions.stop(app.workspace.id, conversationId, run.id);
  expect(latestRun(app.db, conversationId)?.status).toBe('cancelled'); expect(model.calls).toBe(0);
  const id = randomUUID(); acceptRun(app.db, conversationId, id, 'hash'); recoverInterruptedRuns(app.db);
  expect(latestRun(app.db, conversationId)?.status).toBe('interrupted');
});
test('a provider failure is persisted as failure and never displayed as success', async () => {
  await send('[FAIL]'); await waitTerminal();
  expect(latestRun(app.db, conversationId)?.status).toBe('failed');
});
