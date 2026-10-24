import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function startModelServer() {
  let calls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/stats')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ calls }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: {
        role: string;
        content: string | { type: string; text?: string; image_url?: { url: string } }[];
      }[];
    };
    calls++;
    const user = body.messages.findLast((message) => message.role === 'user');
    const results = body.messages
      .slice(
        body.messages.findLastIndex((message) => message.role === 'user') + 1,
      )
      .filter((message) => message.role === 'tool');
    const prompt =
      typeof user?.content === 'string'
        ? user.content
        : (user?.content.map((part) => part.text ?? '').join('') ?? '');
    const context = body.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string'
      ? message.content : message.content.map(part => part.text ?? '').join(''))
      .findLast(text => text.startsWith('<research-workbench-materials>')) ?? '';
    if (prompt.includes('[FAIL]')) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            message: 'Test authentication failure',
            type: 'authentication_error',
          },
        }),
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const id = `chatcmpl-${randomUUID()}`;
    function frame(delta: object, reason: string | null = null) {
      response.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'test-model', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
      );
    }
    if (prompt.includes('[SLOW]')) {
      let index = 0;
      const timer = setInterval(() => {
        frame({ content: `片段${index++} ` });
        if (index === 100) {
          clearInterval(timer);
          frame({}, 'stop');
          response.end('data: [DONE]\n\n');
        }
      }, 70);
      response.on('close', () => {
        clearInterval(timer);
      });
      return;
    }
    if (prompt.includes('[SHELL]')) {
      if (!results.length) {
        frame(
          {
            tool_calls: [
              {
                index: 0,
                id: 'native-command',
                type: 'function',
                function: {
                  name: process.platform === 'win32' ? 'powershell' : 'bash',
                  arguments: JSON.stringify({
                    command:
                      process.platform === 'win32'
                        ? "Set-Content -LiteralPath '../native-command.txt' -Value 'shell-output' -NoNewline"
                        : 'printf shell-output > ../native-command.txt',
                  }),
                },
              },
            ],
          },
          'tool_calls',
        );
      } else frame({ content: '命令执行完成。' }, 'stop');
    } else if (prompt.includes('[WORKSPACE]')) {
      const firstContent = results[0]?.content;
      const raw =
        typeof firstContent === 'string'
          ? firstContent
          : firstContent?.map((part) => part.text ?? '').join('');
      if (!results.length) {
        frame(
          {
            tool_calls: [
              {
                index: 0,
                id: 'workspace-context',
                type: 'function',
                function: {
                  name: 'get_workspace_context',
                  arguments: '{}',
                },
              },
            ],
          },
          'tool_calls',
        );
      } else if (results.length === 1) {
        const context = JSON.parse(raw!) as {
          workspace: { name: string };
          papers: { path: string; name: string }[];
        };
        frame(
          {
            tool_calls: [
              {
                index: 0,
                id: 'write-summary',
                type: 'function',
                function: {
                  name: 'write',
                  arguments: JSON.stringify({
                    path: `${context.papers[0].path}/analysis/summary.custom`,
                    content: `# ${context.workspace.name}\n${context.papers[0].name}`,
                  }),
                },
              },
            ],
          },
          'tool_calls',
        );
      } else {
        const context = JSON.parse(raw!) as { papers: { path: string }[] };
        frame(
          {
            content: `已生成 ${context.papers[0].path}/analysis/summary.custom`,
          },
          'stop',
        );
      }
    } else if (prompt.includes('[EDIT]')) {
      if (!results.length) {
        frame(
          {
            tool_calls: [
              {
                index: 0,
                id: 'read-note',
                type: 'function',
                function: {
                  name: 'read',
                  arguments: JSON.stringify({ path: 'note.txt' }),
                },
              },
            ],
          },
          'tool_calls',
        );
      } else if (results.length === 1) {
        frame(
          {
            tool_calls: [
              {
                index: 0,
                id: 'edit-note',
                type: 'function',
                function: {
                  name: 'edit',
                  arguments: JSON.stringify({
                    path: 'note.txt',
                    oldText: 'alpha',
                    newText: 'beta',
                  }),
                },
              },
            ],
          },
          'tool_calls',
        );
      } else frame({ content: '已读取并修改 note.txt。' }, 'stop');
    } else if (prompt.includes('[TRANSLATE]')) {
      const payload = JSON.parse(prompt) as { blocks: { id: string; text: string; preserve?: boolean }[] };
      frame({ content: JSON.stringify({ blocks: payload.blocks.map(block => ({ id: block.id, text: block.preserve ? block.text : `译文：${block.text}` })) }) }, 'stop');
    } else if (prompt.includes('[OPEN]')) {
      if (!results.length) {
        const system = body.messages.filter(message => message.role === 'system').map(message => typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('')).join('\n');
        const skill = system.match(/<location>([^<]*document-workbench[^<]*)<\/location>/)?.[1];
        if (!skill) frame({ content: '文档技能未注册' }, 'stop');
        else frame({ tool_calls: [{ index: 0, id: 'read-document-skill', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: skill }) } }] }, 'tool_calls');
      } else if (results.length === 1) {
        frame({ tool_calls: [{ index: 0, id: 'open-result', type: 'function', function: { name: 'open_document', arguments: JSON.stringify({ path: 'documents/guide.md', mode: 'preview' }) } }] }, 'tool_calls');
      } else frame({ content: '已读取文档技能并请求展示 documents/guide.md\n\n$E=mc^2$，\\(a_i+b_i\\)\n\n$$\nx^2+y^2=z^2\n$$\n\n\\[\\frac{1}{2}\\]\n\n[打开应用](https://example.com/app)\n\nhttp://localhost:3000/' }, 'stop');
    } else if (prompt.includes('[IMAGE]')) {
      const images = Array.isArray(user?.content) ? user.content.filter(part => part.type === 'image_url') : [];
      const pngs = images.map(image => Buffer.from(image.image_url!.url.split(',')[1], 'base64'));
      const sources = context.split('\n').filter(line => line.startsWith('{') && line.includes('-region'));
      frame({ content: `收到 ${images.length} 张截图；PNG：${pngs.every(png => png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))}\n${sources.join('\n')}` }, 'stop');
    } else if (prompt.includes('[QUOTES]')) {
      const quotes = context.split('\n').filter(line => line.startsWith('{') && line.includes('text-quote')).map(line => JSON.parse(line));
      frame({ content: `收到 ${quotes.length} 段引用\n${quotes.map(quote => `${quote.path}：${quote.text}`).join('\n')}` }, 'stop');
    } else if (prompt.includes('[READING]')) {
      const line = context.split('\n').find(line => line.startsWith('{'));
      const reading = line ? JSON.parse(line) as { path: string; page?: number } : null;
      frame({ content: reading ? `当前文件：${reading.path}；当前页码：${reading.page ?? '无'}` : '没有阅读上下文' }, 'stop');
    } else if (prompt.includes('[LAYOUT]')) {
      frame(
        {
          content: [
            '这里整理了材料与下一步工作。',
          '',
            '| 材料 | 用途 | 状态 |',
            '| --- | --- | --- |',
            '| 论文原文 | 核对定义与实验 | 已读取 |',
            '| 推导笔记 | 补充分析 | 待完善 |',
            '',
            '```text',
            `research/papers/analysis/${'long-source-path/'.repeat(12)}results.json`,
            '```',
          ].join('\n'),
        },
        'stop',
      );
    } else {
      frame({ role: 'assistant', content: '这是通过 Pi SDK 返回的测试回答。' });
      frame({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const config = {
    providers: {
      test: {
        baseUrl,
        api: 'openai-completions',
        apiKey: 'test-only-key',
        models: [
          {
            id: 'test-model',
            name: '测试模型',
            reasoning: false,
            input: ['text', 'image'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 4096,
          },
          {
            id: 'text-only', name: '纯文本模型', reasoning: false, input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096,
          },
        ],
      },
    },
  };
  return {
    config,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
