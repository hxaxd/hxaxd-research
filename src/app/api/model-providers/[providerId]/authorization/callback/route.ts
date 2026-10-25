import { handleApiRequest } from '@/app/api/handle-request';
import { authorizationCallbackSchema } from '@/app/models/schema';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';

export function POST(request: Request, context: { params: Promise<{ providerId: string }> }) {
  return handleApiRequest(request, async () => {
    const { providerId } = await context.params;
    const { id, url } = authorizationCallbackSchema.parse(await request.json());
    return getAppRuntime().models.submit(providerId, id, url);
  });
}
