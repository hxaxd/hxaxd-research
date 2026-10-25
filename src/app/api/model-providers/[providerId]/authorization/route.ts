import { handleApiRequest } from '@/app/api/handle-request';
import { authorizationRequestSchema } from '@/app/models/schema';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';

export function POST(request: Request, context: { params: Promise<{ providerId: string }> }) {
  return handleApiRequest(request, async () => {
    const { providerId } = await context.params;
    const { id } = authorizationRequestSchema.parse(await request.json());
    return getAppRuntime().models.connect(providerId, id);
  });
}

export function DELETE(request: Request, context: { params: Promise<{ providerId: string }> }) {
  return handleApiRequest(request, async () => {
    const { providerId } = await context.params;
    const { id } = authorizationRequestSchema.parse(await request.json());
    return getAppRuntime().models.cancel(providerId, id);
  });
}
