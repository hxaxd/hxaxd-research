export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init?.headers } });
  const data: unknown = await response.json();
  if (!response.ok) {
    const error = typeof data === 'object' && data !== null && 'error' in data ? data.error : null;
    const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : `请求失败（${response.status}）`;
    throw new Error(message);
  }
  return data as T;
}
