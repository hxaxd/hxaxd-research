import { handleApiRequest } from '@/app/api/handle-request';
import { speechChatgptSchema } from '@/features/speech/schema';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';

export function PATCH(request: Request) {
  return handleApiRequest(request, async () => {
    const { model } = speechChatgptSchema.parse(await request.json());
    return getAppRuntime().speech.setChatgptModel(model);
  });
}
