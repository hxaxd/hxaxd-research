import { handleApiRequest } from '@/app/api/handle-request';
import { modelConnectionIdSchema, modelConnectionInputSchema } from '@/app/models/schema';
import { removeModelConnection, saveModelConnection } from '@/app/models/server/connections';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export function PATCH(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    const id = modelConnectionIdSchema.parse((await context.params).id);
    await saveModelConnection(app.config, await app.models.getRuntime(), modelConnectionInputSchema.parse(await request.json()), id);
    return app.models.settings();
  });
}

export function DELETE(request: Request, context: Context) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    const id = modelConnectionIdSchema.parse((await context.params).id);
    await removeModelConnection(app.config, await app.models.getRuntime(), id);
    return app.models.settings();
  });
}
