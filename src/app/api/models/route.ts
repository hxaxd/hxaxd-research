import { handleApiRequest } from '@/app/api/handle-request';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return handleApiRequest(request, () => getAppRuntime().models.list());
}
