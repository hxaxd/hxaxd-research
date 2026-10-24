import type { ApiErrorResponse } from './api-error';

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    throw new Error((data as ApiErrorResponse).error.message);
  }
  return data as T;
}
