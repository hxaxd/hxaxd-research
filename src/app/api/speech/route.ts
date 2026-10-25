import { handleApiRequest } from '@/app/api/handle-request';
import { speechSelectionSchema } from '@/app/models/schema';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return handleApiRequest(request, () => getAppRuntime().models.speechSettings());
}

export function PATCH(request: Request) {
  return handleApiRequest(request, async () => {
    const { activeId } = speechSelectionSchema.parse(await request.json());
    return getAppRuntime().models.selectSpeech(activeId);
  });
}
