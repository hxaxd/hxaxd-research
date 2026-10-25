import { handleApiRequest } from '@/app/api/handle-request';
import { modelDiscoverySchema } from '@/features/models/schema';
import { discoverModels } from '@/features/models/server/connections';
import { getAppRuntime } from '@/server/runtime';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    return discoverModels(app.config, await app.models.getRuntime(), modelDiscoverySchema.parse(await request.json()), request.signal);
  });
}
