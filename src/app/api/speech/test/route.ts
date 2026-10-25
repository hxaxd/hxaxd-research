import { handleApiRequest } from '@/app/api/handle-request';
import { speechConnectionRefSchema } from '@/app/models/schema';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return handleApiRequest(request, async () => {
    const { connectionId } = speechConnectionRefSchema.parse(await request.json());
    const message = await getAppRuntime().speech.test(connectionId, request.signal);
    return { ok: true, message };
  });
}
