import { handleApiRequest } from '@/app/api/handle-request';
import { getAppRuntime } from '@/app/runtime';
import { assistantPromptSchema } from '@/app/settings/assistant-prompt';
import { readAssistantPrompt, writeAssistantPrompt } from '@/app/settings/server/assistant-prompt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return handleApiRequest(request, () => ({ prompt: readAssistantPrompt(getAppRuntime().config.dataDir) }));
}

export function PUT(request: Request) {
  return handleApiRequest(request, async () => {
    const settings = assistantPromptSchema.parse(await request.json());
    writeAssistantPrompt(getAppRuntime().config.dataDir, settings.prompt);
    return settings;
  });
}
