import { useCallback, useEffect, useState } from "react";

import { api } from "../../shared/api/client";
import type { ProjectSummary } from "../../shared/api/contracts";

export function useProjects() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setProjects(await api.projects());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取项目列表");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createProject = useCallback(
    async (name: string) => {
      await api.createProject(name);
      await refresh();
    },
    [refresh],
  );

  return { projects, loading, error, refresh, createProject };
}
