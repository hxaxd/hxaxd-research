import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function startModelServer() {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'text-only' }, { id: 'gpt-6-luna' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const { messages } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: { role: string; content: string | { text?: string }[] }[];
    };
    const text = (content: string | { text?: string }[]) =>
      typeof content === 'string' ? content : content.map(part => part.text ?? '').join('');
    const prompt = text(messages.findLast(message => message.role === 'user')!.content);
    if (prompt.includes('[FAIL]')) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Test authentication failure', type: 'authentication_error' } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    function frame(delta: object, reason: string | null) {
      response.write(`data: ${JSON.stringify({ id: 'test-completion', object: 'chat.completion.chunk', created: 0,
        model: 'test-model', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    }
    if (prompt.includes('[SLOW]')) {
      frame({ role: 'assistant', content: '回答中' }, null);
      return;
    }
    if (prompt.includes('[EDIT]') && messages.at(-1)!.role !== 'tool') {
      frame({ tool_calls: [{ index: 0, id: 'edit-note', type: 'function', function: {
        name: 'edit', arguments: JSON.stringify({ path: 'note.txt', oldText: 'alpha', newText: 'beta' }),
      } }] }, 'tool_calls');
    } else if (prompt.includes('[TRANSLATE]')) {
      const payload = JSON.parse(prompt) as { blocks: { id: string; text: string; preserve?: boolean }[] };
      frame({ content: JSON.stringify({ blocks: payload.blocks.map(block => ({
        id: block.id, text: block.preserve ? block.text : `译文：${block.text}`,
      })) }) }, 'stop');
    } else if (prompt.includes('[REASONING]')) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      frame({ content: JSON.stringify({ reasoning: body.reasoning_effort }) }, 'stop');
    } else if (prompt.includes('[READING]')) {
      const context = messages.filter(message => message.role === 'user').map(message => text(message.content))
        .findLast(content => content.startsWith('<research-workbench-materials>'))!;
      const reading = JSON.parse(context.split('\n').find(line => line.startsWith('{'))!);
      frame({ content: `当前文件：${reading.path}；当前页码：${reading.page}` }, 'stop');
    } else {
      frame({ role: 'assistant', content: '测试回答' }, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    config: {
      providers: {
        test: {
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          api: 'openai-completions', apiKey: 'test-only-key',
          models: [
            { id: 'test-model', name: '测试模型', input: ['text', 'image'], contextWindow: 32000, maxTokens: 4096 },
            { id: 'text-only', name: '纯文本模型', input: ['text'], contextWindow: 32000, maxTokens: 4096 },
          ],
        },
      },
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
