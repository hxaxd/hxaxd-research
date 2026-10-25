import { z } from 'zod';

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

export type SpeechTestResult = z.infer<typeof speechTestResultSchema>;
