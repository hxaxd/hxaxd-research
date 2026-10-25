import { handleApiRequest } from '@/app/api/handle-request';
import { speechConnectionInputSchema } from '@/app/models/schema';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return handleApiRequest(request, async () => {
    const input = speechConnectionInputSchema.parse(await request.json());
    return getAppRuntime().models.createSpeech(input);
  });
}
