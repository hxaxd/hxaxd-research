import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { speechConnectionInputSchema } from '@/app/models/schema';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';

export function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleApiRequest(request, async () => {
    const { id } = await validatedIds(context);
    const input = speechConnectionInputSchema.parse(await request.json());
    return getAppRuntime().models.updateSpeech(id, input);
  });
}

export function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleApiRequest(request, async () => {
    const { id } = await validatedIds(context);
    return getAppRuntime().models.removeSpeech(id);
  });
}
