import { useCallback, useEffect, useState } from "react";

export function useApiResource<T>(loader: () => Promise<T>, dependencies: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const next = await loader();
      setData(next);
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "请求失败");
      return null;
    } finally {
      setLoading(false);
    }
    // The caller owns stable primitive dependency values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  return { data, loading, error, reload, setData };
}
