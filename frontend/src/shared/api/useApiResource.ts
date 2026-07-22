import { useCallback, useEffect, useRef, useState } from "react";

export function useApiResource<T>(loader: () => Promise<T>, dependencies: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  const reload = useCallback(async () => {
    const requestId = ++latestRequest.current;
    setError(null);
    try {
      const next = await loader();
      if (requestId === latestRequest.current) setData(next);
      return next;
    } catch (reason) {
      if (requestId === latestRequest.current) {
        setError(reason instanceof Error ? reason.message : "请求失败");
      }
      return null;
    } finally {
      if (requestId === latestRequest.current) setLoading(false);
    }
    // The caller owns stable primitive dependency values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);

  const retry = useCallback(async () => {
    setLoading(true);
    return reload();
  }, [reload]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  return { data, loading, error, reload, retry, setData };
}
