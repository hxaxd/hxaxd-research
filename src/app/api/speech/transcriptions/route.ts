import { text as t } from '@/app/i18n/server.mjs';
import { handleApiRequest } from '@/app/api/handle-request';
import { speechConnectionRefSchema } from '@/app/models/schema';
import { getAppRuntime } from '@/app/runtime';
import { ApiError } from '@/shared/http/api-error';

export const runtime = 'nodejs';


export function POST(request: Request) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    const maxAudio = app.config.files.audioBytes;
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > maxAudio)
      throw new ApiError(413, 'speech_audio_too_large', t('errors.audioSize'));
    const form = await request.formData().catch(() => {
      throw new ApiError(400, 'speech_audio_missing', t('errors.audioRead'));
    });
    const { connectionId } = speechConnectionRefSchema.parse({
      connectionId: form.get('connectionId'),
    });
    const audio = form.get('audio');
    if (!(audio instanceof Blob) || audio.size === 0)
      throw new ApiError(400, 'speech_audio_missing', t('errors.audioMissing'));
    if (audio.size > maxAudio)
      throw new ApiError(413, 'speech_audio_too_large', t('errors.audioSize'));
    const filename = audio instanceof File ? audio.name : 'recording.webm';
    const text = await app.speech.transcribe(
      connectionId,
      audio,
      filename,
      request.signal,
    );
    return { text };
  });
}
