import { z } from 'zod';

export const assistantPromptSchema = z.strictObject({ prompt: z.string() });
export type AssistantPrompt = z.infer<typeof assistantPromptSchema>;
