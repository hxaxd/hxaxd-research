import 'server-only';

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { AppConfig } from '@/server/config';
import { ApiError } from '@/shared/http/api-error';

import {
  speechConnectionInputSchema,
  type SpeechConnection,
  type SpeechConnectionInput,
  type SpeechProtocol,
} from '../schema';

export const defaultChatgptModel = 'gpt-live-transcribe';

const storedConnectionSchema = speechConnectionInputSchema
  .omit({ clearKey: true })
  .extend({ id: z.string() });

const storedSchema = z.object({
  activeId: z.string().nullable(),
  chatgptModel: z.string(),
  connections: z.array(storedConnectionSchema),
});

type Stored = z.infer<typeof storedSchema>;
type StoredConnection = Stored['connections'][number];

export type SpeechTarget =
  | { kind: 'chatgpt'; model: string; token: string }
  | {
      kind: 'custom';
      protocol: SpeechProtocol;
      baseUrl: string;
      model: string;
      key?: string;
    };

function normalizeBaseUrl(value: string) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function publicConnection(connection: StoredConnection): SpeechConnection {
  return {
    id: connection.id,
    name: connection.name,
    protocol: connection.protocol,
    baseUrl: connection.baseUrl,
    model: connection.model,
    hasKey: Boolean(connection.key),
  };
}

export class SpeechConnections {
  constructor(private readonly config: AppConfig) {}

  get file() {
    return path.join(this.config.dataDir, 'speech.json');
  }

  private read(): Stored {
    if (!existsSync(this.file))
      return {
        activeId: 'chatgpt',
        chatgptModel: defaultChatgptModel,
        connections: [],
      };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      throw new ApiError(500, 'speech_config_invalid', '语音配置文件无法解析，请检查本机的 speech.json');
    }
    const result = storedSchema.safeParse(parsed);
    if (!result.success)
      throw new ApiError(500, 'speech_config_invalid', '语音配置文件格式无效，请检查本机的 speech.json');
    return result.data;
  }

  private write(data: Stored) {
    writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  }

  readSettings() {
    const data = this.read();
    return {
      activeId: data.activeId,
      chatgptModel: data.chatgptModel,
      connections: data.connections.map(publicConnection),
    };
  }

  resolve(connectionId: string) {
    const data = this.read();
    if (connectionId === 'chatgpt') return { kind: 'chatgpt' as const, model: data.chatgptModel };
    const connection = data.connections.find((item) => item.id === connectionId);
    if (!connection)
      throw new ApiError(404, 'speech_connection_missing', '语音连接不存在，请刷新后重试');
    return {
      kind: 'custom' as const,
      protocol: connection.protocol,
      baseUrl: connection.baseUrl,
      model: connection.model,
      ...(connection.key ? { key: connection.key } : {}),
    };
  }

  select(activeId: string | null) {
    const data = this.read();
    if (activeId !== null && activeId !== 'chatgpt' && !data.connections.some((item) => item.id === activeId))
      throw new ApiError(404, 'speech_connection_missing', '语音连接不存在，请刷新后重试');
    this.write({ ...data, activeId });
  }

  setChatgptModel(model: string) {
    const data = this.read();
    this.write({ ...data, chatgptModel: model });
  }

  create(input: SpeechConnectionInput) {
    const data = this.read();
    const connection: StoredConnection = {
      id: randomUUID(),
      name: input.name,
      protocol: input.protocol,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      model: input.model,
      ...(input.key?.trim() ? { key: input.key.trim() } : {}),
    };
    this.write({
      ...data,
      activeId: connection.id,
      connections: [...data.connections, connection],
    });
  }

  update(id: string, input: SpeechConnectionInput) {
    const data = this.read();
    const current = data.connections.find((item) => item.id === id);
    if (!current)
      throw new ApiError(404, 'speech_connection_missing', '语音连接不存在，请刷新后重试');
    const key = input.clearKey
      ? undefined
      : input.key?.trim()
        ? input.key.trim()
        : current.key;
    const connection: StoredConnection = {
      id,
      name: input.name,
      protocol: input.protocol,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      model: input.model,
      ...(key ? { key } : {}),
    };
    this.write({
      ...data,
      connections: data.connections.map((item) => (item.id === id ? connection : item)),
    });
  }

  remove(id: string) {
    const data = this.read();
    if (!data.connections.some((item) => item.id === id))
      throw new ApiError(404, 'speech_connection_missing', '语音连接不存在，请刷新后重试');
    this.write({
      ...data,
      connections: data.connections.filter((item) => item.id !== id),
      activeId: data.activeId === id ? 'chatgpt' : data.activeId,
    });
  }
}
