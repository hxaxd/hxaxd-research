import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './api-error';
import { getAppRuntime } from '@/server/app-runtime';
import { idSchema } from '@/features/workspaces/workspace-schema';
export async function handleApiRequest(request: Request, operation: () => Promise<unknown> | unknown): Promise<Response> {
  const requestId = randomUUID();
  try {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.get('origin');
      if (origin) {
        const source = new URL(origin);
        const target = new URL(request.url);
        // Next normalizes the internal URL hostname; Host retains the browser's address.
        const host = request.headers.get('host') ?? target.host;
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname) || source.protocol !== target.protocol || source.host !== host) throw new ApiError(403, 'invalid_origin', '不允许来自其他页面的写入请求');
      }
    }
    await getAppRuntime().ready;
    const result = await operation();
    const response = result instanceof Response ? result : Response.json(result);
    if (!response.headers.has('Cache-Control')) response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Request-Id', requestId);
    return response;
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return Response.json({ error: { code: 'invalid_input', message: '输入无效，请检查名称、路径和请求参数', requestId } }, { status: 400 });
    if (error instanceof ApiError) return Response.json({ error: { code: error.code, message: error.message, requestId } }, { status: error.status });
    console.error('Request failed', requestId, error);
    return Response.json({ error: { code: 'internal_error', message: `操作失败，请检查本地服务日志（${requestId.slice(0, 8)}）`, requestId } }, { status: 500 });
  }
}
export async function validatedIds<P extends Record<string, string>>(context: { params: Promise<P> }): Promise<P> {
  const params = await context.params;
  for (const value of Object.values(params)) idSchema.parse(value);
  return params;
}
