import { handleApiRequest } from '@/app/api/handle-request';
import { speechConnectionRefSchema } from '@/features/models/schema';
import { getAppRuntime } from '@/server/runtime';
import { ApiError } from '@/shared/http/api-error';

export const runtime = 'nodejs';


export function POST(request: Request) {
  return handleApiRequest(request, async () => {
    const app = getAppRuntime();
    const maxAudio = app.config.files.audioBytes;
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > maxAudio)
      throw new ApiError(413, 'speech_audio_too_large', '录音超过大小限制，请缩短录音后重试');
    const form = await request.formData().catch(() => {
      throw new ApiError(400, 'speech_audio_missing', '无法读取录音数据');
    });
    const { connectionId } = speechConnectionRefSchema.parse({
      connectionId: form.get('connectionId'),
    });
    const audio = form.get('audio');
    if (!(audio instanceof Blob) || audio.size === 0)
      throw new ApiError(400, 'speech_audio_missing', '没有收到录音数据');
    if (audio.size > maxAudio)
      throw new ApiError(413, 'speech_audio_too_large', '录音超过大小限制，请缩短录音后重试');
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
