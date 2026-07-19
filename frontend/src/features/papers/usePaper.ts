import { useCallback, useEffect, useState } from "react";

import { api } from "../../shared/api/client";
import type { Paper } from "../../shared/api/contracts";

export function usePaper(paperId: string) {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setPaper(await api.paper(paperId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取论文");
    } finally {
      setLoading(false);
    }
  }, [paperId]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  return { paper, loading, error, reload };
}

