import { z } from 'zod';

const speechProtocolSchema = z.enum(['realtime', 'file']);

const speechBaseUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, '请填写不带账号、查询参数或片段的 http(s) 地址');

export const speechConnectionInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  protocol: speechProtocolSchema,
  baseUrl: speechBaseUrlSchema,
  model: z.string().trim().min(1).max(200),
  key: z.string().max(4096).optional(),
  clearKey: z.boolean().optional(),
});

const speechConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: speechProtocolSchema,
  baseUrl: z.string(),
  model: z.string(),
  hasKey: z.boolean(),
});

export const speechSettingsSchema = z.object({
  activeId: z.string().nullable(),
  chatgpt: z.object({ connected: z.boolean(), model: z.string() }),
  connections: z.array(speechConnectionSchema),
});

export const speechSelectionSchema = z.object({ activeId: z.string().nullable() });
export const speechChatgptSchema = z.object({
  model: z.string().trim().min(1).max(200),
});
export const speechConnectionRefSchema = z.object({
  connectionId: z.string().min(1),
});
export const speechTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
export const speechRealtimeSchema = z.object({
  connectionId: z.string(),
  sdp: z.string().min(1).max(200_000),
});
export const speechRealtimeResultSchema = z.object({ sdp: z.string() });
export const speechTranscriptSchema = z.object({ text: z.string() });

export type SpeechProtocol = z.infer<typeof speechProtocolSchema>;
export type SpeechConnection = z.infer<typeof speechConnectionSchema>;
export type SpeechSettings = z.infer<typeof speechSettingsSchema>;
export type SpeechConnectionInput = z.infer<typeof speechConnectionInputSchema>;
export type SpeechTestResult = z.infer<typeof speechTestResultSchema>;
