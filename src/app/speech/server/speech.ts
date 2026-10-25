import 'server-only';
import { text as t } from '@/app/i18n/server.mjs';

import type { ModelProviders } from '@/app/models/server/providers';
import type { AppConfig } from '@/app/config.mjs';
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
      throw new ApiError(409, 'speech_protocol_unsupported', t('errors.fileSpeechProtocol'));
    return realtimeAnswer(target, sdp, signal, this.config.timeouts);
  }

  async transcribe(connectionId: string, audio: Blob, filename: string, signal: AbortSignal) {
    const target = await this.models.speechTarget(connectionId, signal);
    if (target.kind === 'custom' && target.protocol === 'realtime')
      throw new ApiError(409, 'speech_protocol_unsupported', t('errors.realtimeSpeechProtocol'));
    return fileTranscript(target, audio, filename, signal, this.config.timeouts);
  }

  async test(connectionId: string, signal: AbortSignal) {
    const target = await this.models.speechTarget(connectionId, signal);
    return testTarget(target, signal, this.config.timeouts);
  }
}
