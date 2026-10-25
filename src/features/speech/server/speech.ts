import 'server-only';

import type { ModelProviders } from '@/features/models/server/providers';
import type { AppConfig } from '@/server/config';
import { ApiError } from '@/shared/http/api-error';

import { fileTranscript, realtimeAnswer, testTarget } from './transcription';

export class Speech {
  constructor(
    private readonly config: AppConfig,
    private readonly models: ModelProviders,
  ) {}

  async answer(connectionId: string, sdp: string, signal: AbortSignal) {
    const target = await this.models.speechTarget(connectionId, signal);
    if (target.kind === 'custom' && target.protocol === 'file')
      throw new ApiError(409, 'speech_protocol_unsupported', '该连接在录音结束后转写，不支持实时录音');
    return realtimeAnswer(target, sdp, signal);
  }

  async transcribe(connectionId: string, audio: Blob, filename: string, signal: AbortSignal) {
    const target = await this.models.speechTarget(connectionId, signal);
    if (target.kind === 'custom' && target.protocol === 'realtime')
      throw new ApiError(409, 'speech_protocol_unsupported', '该连接使用实时转写，请在录音过程中连接');
    return fileTranscript(target, audio, filename, signal);
  }

  async test(connectionId: string, signal: AbortSignal) {
    const target = await this.models.speechTarget(connectionId, signal);
    return testTarget(target, signal);
  }
}
