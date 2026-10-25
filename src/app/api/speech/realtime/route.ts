import { handleApiRequest } from '@/app/api/handle-request';
import { speechRealtimeSchema } from '@/app/speech/schema';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return handleApiRequest(request, async () => {
    const { connectionId, sdp } = speechRealtimeSchema.parse(await request.json());
    return {
      sdp: await getAppRuntime().speech.answer(connectionId, sdp, request.signal),
    };
  });
}
