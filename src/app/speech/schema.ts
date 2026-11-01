import { z } from 'zod';

export const speechTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
export const speechRealtimeSchema = z.object({
  connectionId: z.string(),
});
export const speechRealtimeResultSchema = z.object({
  url: z.string(),
  key: z.string(),
  session: z.object({
    type: z.literal('transcription'),
    audio: z.object({ input: z.object({
      format: z.object({ type: z.literal('audio/pcm'), rate: z.literal(24000) }),
      transcription: z.object({ model: z.string() }),
      turn_detection: z.null(),
    }) }),
  }),
  timeoutMs: z.number(),
});
export const speechTranscriptSchema = z.object({ text: z.string() });

export type SpeechTestResult = z.infer<typeof speechTestResultSchema>;
export type SpeechRealtimeSession = z.infer<typeof speechRealtimeResultSchema>;
