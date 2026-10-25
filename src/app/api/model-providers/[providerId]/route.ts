import { handleApiRequest } from '@/app/api/handle-request';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';

export function DELETE(request: Request, context: { params: Promise<{ providerId: string }> }) {
  return handleApiRequest(request, async () => {
    const { providerId } = await context.params;
    return getAppRuntime().models.disconnect(providerId);
  });
}
