import { handleApiRequest } from '@/app/api/handle-request';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';

export function DELETE(request: Request) {
  return handleApiRequest(request, () => getAppRuntime().models.disconnect());
}
