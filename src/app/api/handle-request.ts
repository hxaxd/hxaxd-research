import 'server-only';
import { text as t, requestLocale, withLocale } from '@/app/i18n/server.mjs';

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { ApiError, isApiError } from '@/shared/http/api-error';
import { idSchema } from '@/shared/schema';

export async function handleApiRequest(
  request: Request,
  operation: () => Promise<unknown> | unknown,
): Promise<Response> {
  return withLocale(requestLocale(request), async () => {
    const requestId = randomUUID();
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        const origin = request.headers.get('origin');
        if (origin) {
          const source = new URL(origin);
          const target = new URL(request.url);
          // Next normalizes the internal URL hostname; Host retains the browser's address.
          const host = request.headers.get('host') ?? target.host;
          if (
            !['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname) ||
            source.protocol !== target.protocol ||
            source.host !== host
          )
            throw new ApiError(
              403,
              'invalid_origin',
              t('errors.origin'),
            );
        }
      }
      const result = await operation();
      const response =
        result instanceof Response ? result : Response.json(result);
      if (!response.headers.has('Cache-Control'))
        response.headers.set('Cache-Control', 'no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('X-Request-Id', requestId);
      return response;
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return Response.json(
          {
            error: {
              code: 'invalid_input',
              message: t('errors.input'),
              requestId,
            },
          },
          { status: 400 },
        );
      if (isApiError(error))
        return Response.json(
          { error: { code: error.code, message: error.message, requestId } },
          { status: error.status },
        );
      console.error('Request failed', requestId, error);
      return Response.json(
        {
          error: {
            code: 'internal_error',
            message: t('errors.internal', {value0: requestId.slice(0, 8)}),
            requestId,
          },
        },
        { status: 500 },
      );
    }
  });
}

export async function validatedIds<P extends Record<string, string>>(context: {
  params: Promise<P>;
}): Promise<P> {
  const params = await context.params;
  for (const value of Object.values(params)) idSchema.parse(value);
  return params;
}
