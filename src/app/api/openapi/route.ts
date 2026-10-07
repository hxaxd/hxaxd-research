import { handleApiRequest } from '@/shared/http/handle-api-request';
import { generateOpenapi } from '@/shared/http/generate-openapi';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) { return handleApiRequest(request, generateOpenapi); }
