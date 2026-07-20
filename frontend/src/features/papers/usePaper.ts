import { useCallback, useEffect, useState } from "react";

import { api } from "../../shared/api/client";
import type { Paper, Project, ProjectPaper } from "../../shared/api/contracts";

export interface PaperProjectContext {
  project: Project;
  membership: ProjectPaper;
}

export function usePaper(paperId: string) {
  const [paper, setPaper] = useState<Paper | null>(null);
  const [projects, setProjects] = useState<PaperProjectContext[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [nextPaper, nextProjects] = await Promise.all([api.paper(paperId), api.paperProjects(paperId)]);
      setPaper(nextPaper);
      const projectContexts = await Promise.all(
        nextProjects.map(async (membership) => ({
          membership,
          project: await api.project(membership.project_id),
        })),
      );
      setProjects(projectContexts);
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

  return { paper, projects, loading, error, reload };
}
