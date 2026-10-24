import { handleApiRequest } from '@/app/api/handle-request';
import { speechSelectionSchema } from '@/features/speech/schema';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return handleApiRequest(request, () => getAppRuntime().speech.settings());
}

export function PATCH(request: Request) {
  return handleApiRequest(request, async () => {
    const { activeId } = speechSelectionSchema.parse(await request.json());
    return getAppRuntime().speech.select(activeId);
  });
}
