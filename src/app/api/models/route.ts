import { handleApiRequest } from '@/shared/http/handle-api-request';
import { getAppRuntime } from '@/server/app-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) { return handleApiRequest(request, () => getAppRuntime().sessions.models()); }

