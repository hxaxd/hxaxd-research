import { handleApiRequest } from '@/app/api/handle-request';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';

export function DELETE(request: Request) {
  return handleApiRequest(request, () => getAppRuntime().models.disconnect());
}
