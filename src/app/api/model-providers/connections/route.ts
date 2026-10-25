import { handleApiRequest } from '@/app/api/handle-request';
import { modelConnectionInputSchema } from '@/features/models/schema';
import { saveModelConnection } from '@/features/models/server/connections';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    await saveModelConnection(app.config, await app.models.getRuntime(), modelConnectionInputSchema.parse(await request.json()));
    return app.models.settings();
  });
}
