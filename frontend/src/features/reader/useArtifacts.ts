import { useCallback, useEffect, useState } from "react";

import { api } from "../../shared/api/client";
import type { Artifact } from "../../shared/api/contracts";

export function useArtifacts(paperId: string) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setArtifacts(await api.artifacts(paperId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取 PDF 文件");
    } finally {
      setLoading(false);
    }
  }, [paperId]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  return { artifacts, loading, error, reload };
}

