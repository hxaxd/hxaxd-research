import { useEffect, useState } from "react";

import { api } from "../../shared/api/client";
import type { Paper, Project } from "../../shared/api/contracts";

export function useProjectPapers(projectId: string) {
  const [project, setProject] = useState<Project | null>(null);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void Promise.all([api.project(projectId), api.papers(projectId)])
      .then(([nextProject, nextPapers]) => {
        if (!active) return;
        setProject(nextProject);
        setPapers(nextPapers);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "无法读取项目");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  return { project, papers, loading, error };
}

