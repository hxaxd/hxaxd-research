import { handleApiRequest } from '@/app/api/handle-request';
import { speechConnectionInputSchema } from '@/features/models/schema';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return handleApiRequest(request, async () => {
    const input = speechConnectionInputSchema.parse(await request.json());
    return getAppRuntime().models.createSpeech(input);
  });
}
