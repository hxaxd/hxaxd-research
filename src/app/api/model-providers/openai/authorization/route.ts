import { handleApiRequest } from '@/app/api/handle-request';
import { authorizationRequestSchema } from '@/app/models/schema';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return handleApiRequest(request, async () => {
    const { id } = authorizationRequestSchema.parse(await request.json());
    return getAppRuntime().models.connect(id);
  });
}

export function DELETE(request: Request) {
  return handleApiRequest(request, async () => {
    const { id } = authorizationRequestSchema.parse(await request.json());
    return getAppRuntime().models.cancel(id);
  });
}
