import { handleApiRequest } from '@/app/api/handle-request';
import { modelConnectionInputSchema } from '@/app/models/schema';
import { saveModelConnection } from '@/app/models/server/connections';
import { getAppRuntime } from '@/app/runtime';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    await saveModelConnection(app.config, await app.models.getRuntime(), modelConnectionInputSchema.parse(await request.json()));
    return app.models.settings();
  });
}
