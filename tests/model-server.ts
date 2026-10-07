import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
export async function startModelServer() {
  let calls = 0;
  let closedSlowStreams = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/stats')) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ calls, closedSlowStreams })); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { role: string; content: string | { type: string; text?: string }[] }[] };
    calls++;
    const user = body.messages.findLast(message => message.role === 'user');
    const prompt = typeof user?.content === 'string' ? user.content : user?.content.map(part => part.text ?? '').join('') ?? '';
    if (prompt.includes('[FAIL]')) { response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Test authentication failure', type: 'authentication_error' } })); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const id = `chatcmpl-${randomUUID()}`;
    function frame(delta: object, reason: string | null = null) { response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'test-model', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`); }
    if (prompt.includes('[SLOW]')) {
      let index = 0;
      const timer = setInterval(() => { frame({ content: `片段${index++} ` }); if (index === 100) { clearInterval(timer); frame({}, 'stop'); response.end('data: [DONE]\n\n'); } }, 70);
      response.on('close', () => { clearInterval(timer); closedSlowStreams++; });
      return;
    }
    if (prompt.includes('[EDIT]')) {
      const results = body.messages.filter(message => message.role === 'tool');
      if (!results.length) { frame({ tool_calls: [{ index: 0, id: 'read-note', type: 'function', function: { name: 'read_workspace_text', arguments: JSON.stringify({ path: 'note.txt' }) } }] }, 'tool_calls'); }
      else if (results.length === 1) {
        const content = results[0].content;
        const raw = typeof content === 'string' ? content : content.map(part => part.text ?? '').join('');
        const result = JSON.parse(raw) as { hash: string };
        frame({ tool_calls: [{ index: 0, id: 'edit-note', type: 'function', function: { name: 'edit_workspace_text', arguments: JSON.stringify({ path: 'note.txt', oldText: 'alpha', newText: 'beta', expectedHash: result.hash }) } }] }, 'tool_calls');
      } else frame({ content: '已读取并修改 note.txt。' }, 'stop');
    } else { frame({ role: 'assistant', content: '这是通过 Pi SDK 返回的测试回答。' }); frame({}, 'stop'); }
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const config = { providers: { test: { baseUrl, api: 'openai-completions', apiKey: 'test-only-key', models: [{ id: 'test-model', name: '测试模型', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }] } } };
  return { config, get calls() { return calls; }, get closedSlowStreams() { return closedSlowStreams; }, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
