import { useCallback, useEffect, useState } from "react";

import { api } from "../../shared/api/client";
import type { Resource } from "../../shared/api/contracts";

export function useResources(paperId: string) {
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setError(null);
    try { setResources(await api.resources(paperId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取论文资源"); }
    finally { setLoading(false); }
  }, [paperId]);
  useEffect(() => { setLoading(true); void reload(); }, [reload]);
  return { resources, loading, error, reload };
}
