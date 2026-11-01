import 'server-only';

import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { text as t } from '@/app/i18n/server.mjs';
import type { UserQuestion } from '../../schema';

export function askUserTool(ask: (question: UserQuestion, signal?: AbortSignal) => Promise<string | null>) {
  return defineTool({
    name: 'ask_user',
    label: t('tools.askUser'),
    description: '向用户提问并等待回答。需要用户明确需求、选择方案或批准操作时使用，不要仅在回复中提问后结束。一次问一个影响下一步的问题，提供简短可点选的选项；用户也可输入自己的答案。已有明确要求时直接执行，不重复确认。用户取消会结束当前运行，不能视为同意。',
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 2000 }),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 2, maxItems: 6 })),
    }),
    async execute(id, args, signal, onUpdate) {
      const question: UserQuestion = { id, prompt: args.prompt, options: args.options ?? [] };
      const waiting = ask(question, signal);
      onUpdate?.({ content: [{ type: 'text', text: args.prompt }], details: { question } });
      const answer = await waiting;
      const result = { ...question, answer };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { question: result } };
    },
  });
}
