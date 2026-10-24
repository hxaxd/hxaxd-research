import { handleApiRequest, validatedIds } from '@/app/api/handle-request';
import { speechConnectionInputSchema } from '@/features/speech/schema';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';

export function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleApiRequest(request, async () => {
    const { id } = await validatedIds(context);
    const input = speechConnectionInputSchema.parse(await request.json());
    return getAppRuntime().speech.update(id, input);
  });
}

export function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleApiRequest(request, async () => {
    const { id } = await validatedIds(context);
    return getAppRuntime().speech.remove(id);
  });
}
