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
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request.url === '/v1/responses') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (event: object) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      emit({ type: 'response.created', response: { id: 'response-test' } });
      const nativeSearch = body.tools?.some((tool: { type: string }) => tool.type === 'web_search');
      const latest = body.input.findLastIndex((item: { role?: string }) => item.role === 'user');
      const result = body.input.slice(latest + 1).findLast((item: { type: string }) => item.type === 'function_call_output');
      const item = !nativeSearch && !result
        ? { type: 'function_call', id: 'fc-search', call_id: 'search', name: 'web_search', arguments: JSON.stringify({ query: 'Find the official paper' }), status: 'completed' }
        : { type: 'message', id: 'msg-search', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: nativeSearch ? 'Retrieved [paper](https://arxiv.org/abs/1706.03762)' : result.output, annotations: [] }] };
      if (nativeSearch) {
        emit({ type: 'response.output_item.done', output_index: 0, item: { id: 'ws-search', type: 'web_search_call', status: 'completed' } });
        emit({ type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', title: 'Attention Is All You Need', url: 'https://arxiv.org/abs/1706.03762' } });
      }
      emit({ type: 'response.output_item.added', output_index: 1, item });
      emit({ type: 'response.output_item.done', output_index: 1, item });
      emit({ type: 'response.completed', response: { id: 'response-test', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      response.end();
      return;
    }
    const { messages } = body as {
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
    if (prompt.includes('[ASK]') && messages.at(-1)!.role !== 'tool') {
      frame({ tool_calls: [{ index: 0, id: 'ask-choice', type: 'function', function: {
        name: 'ask_user', arguments: JSON.stringify({ prompt: '由谁完成翻译？', options: ['当前助手', '注册模型'] }),
      } }] }, 'tool_calls');
    } else if (prompt.includes('[SEARCH]') && messages.at(-1)!.role !== 'tool') {
      frame({ tool_calls: [{ index: 0, id: 'search-paper', type: 'function', function: {
        name: 'web_search', arguments: JSON.stringify({ query: 'Find the official paper' }),
      } }] }, 'tool_calls');
    } else if (prompt.includes('[OPEN]') && messages.at(-1)!.role !== 'tool') {
      frame({ tool_calls: [{ index: 0, id: 'open-paper', type: 'function', function: {
        name: 'open_document', arguments: JSON.stringify({ path: 'paper.pdf', page: 3 }),
      } }] }, 'tool_calls');
    } else if (prompt.includes('[ASK]') || prompt.includes('[SEARCH]')) {
      frame({ content: text(messages.at(-1)!.content) }, 'stop');
    } else if (prompt.includes('[EDIT]') && messages.at(-1)!.role !== 'tool') {
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
      const [reading, ...quotes] = context.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      frame({ content: JSON.stringify({ reading, quotes }) }, 'stop');
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
