import { handleApiRequest } from '@/app/api/handle-request';
import { authorizationCallbackSchema } from '@/features/models/schema';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return handleApiRequest(request, async () => {
    const { id, url } = authorizationCallbackSchema.parse(await request.json());
    return getAppRuntime().models.submit(id, url);
  });
}
