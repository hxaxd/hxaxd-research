import { handleApiRequest } from '@/app/api/handle-request';

import { generateOpenapi } from './document';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return handleApiRequest(request, generateOpenapi);
}
