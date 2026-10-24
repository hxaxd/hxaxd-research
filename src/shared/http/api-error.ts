import { z } from 'zod';

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }),
});
export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;

// Bundled server chunks can hold separate copies of this module; a global symbol
// keeps the brand intact so route handlers still recognise their own errors.
const brand = Symbol.for('hxaxd-research.api-error');

export class ApiError extends Error {
  readonly [brand] = true;

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isApiError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError ||
    (typeof error === 'object' && error !== null && brand in error)
  );
}
