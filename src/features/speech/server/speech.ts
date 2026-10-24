import 'server-only';

import type { ModelProviders } from '@/features/models/server/providers';
import type { AppConfig } from '@/server/config';
import { ApiError } from '@/shared/http/api-error';

import type { SpeechConnectionInput, SpeechSettings } from '../schema';
import { SpeechConnections } from './connections';
import { fileTranscript, realtimeAnswer, testTarget } from './transcription';

export class Speech {
  private readonly connections: SpeechConnections;

  constructor(
    config: AppConfig,
    private readonly models: ModelProviders,
  ) {
    this.connections = new SpeechConnections(config);
  }

  async settings(): Promise<SpeechSettings> {
    const [stored, connected] = await Promise.all([
      this.connections.readSettings(),
      this.models.speechAuthorization(),
    ]);
    return {
      activeId: stored.activeId,
      chatgpt: { connected, model: stored.chatgptModel },
      connections: stored.connections,
    };
  }

  private async target(connectionId: string, signal?: AbortSignal) {
    const target = this.connections.resolve(connectionId);
    if (target.kind === 'chatgpt')
      return { ...target, token: await this.models.speechAccessToken(signal) };
    return target;
  }

  async select(activeId: string | null) {
    this.connections.select(activeId);
    return this.settings();
  }

  async create(input: SpeechConnectionInput) {
    this.connections.create(input);
    return this.settings();
  }

  async update(id: string, input: SpeechConnectionInput) {
    this.connections.update(id, input);
    return this.settings();
  }

  async remove(id: string) {
    this.connections.remove(id);
    return this.settings();
  }

  async setChatgptModel(model: string) {
    this.connections.setChatgptModel(model);
    return this.settings();
  }

  async answer(connectionId: string, sdp: string, signal: AbortSignal) {
    const target = await this.target(connectionId, signal);
    if (target.kind === 'custom' && target.protocol === 'file')
      throw new ApiError(409, 'speech_protocol_unsupported', '该连接在录音结束后转写，不支持实时录音');
    return realtimeAnswer(target, sdp, signal);
  }

  async transcribe(connectionId: string, audio: Blob, filename: string, signal: AbortSignal) {
    const target = await this.target(connectionId, signal);
    if (target.kind === 'custom' && target.protocol === 'realtime')
      throw new ApiError(409, 'speech_protocol_unsupported', '该连接使用实时转写，请在录音过程中连接');
    return fileTranscript(target, audio, filename, signal);
  }

  async test(connectionId: string, signal: AbortSignal) {
    const target = await this.target(connectionId, signal);
    return testTarget(target, signal);
  }
}
