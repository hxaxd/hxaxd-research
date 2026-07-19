import { useState } from "react";
import { NavLink } from "react-router-dom";

import { api } from "../../shared/api/client";
import type { Paper, ProjectSummary } from "../../shared/api/contracts";

interface ProjectBranchProps {
  project: ProjectSummary;
}

export function ProjectBranch({ project }: ProjectBranchProps) {
  const [expanded, setExpanded] = useState(false);
  const [papers, setPapers] = useState<Paper[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && papers === null) {
      setError(null);
      try {
        setPapers(await api.papers(project.id));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "无法读取论文");
      }
    }
  }

  return (
    <li className="tree-project">
      <div className="tree-row tree-row--project">
        <button
          className="tree-toggle"
          type="button"
          aria-label={expanded ? "收起项目" : "展开项目"}
          onClick={() => void toggle()}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <NavLink to={`/projects/${project.id}`} title={project.name}>
          <span>{project.name}</span>
          <span className="tree-count">{project.paper_count}</span>
        </NavLink>
      </div>
      {expanded ? (
        <ul className="tree-paper-list">
          {error ? <li className="tree-error">{error}</li> : null}
          {papers?.map((paper) => (
            <li key={paper.id}>
              <NavLink to={`/papers/${paper.id}`} title={paper.title_zh}>
                <span className="paper-dot" aria-hidden="true" />
                <span>{paper.title_zh}</span>
              </NavLink>
            </li>
          ))}
          {papers?.length === 0 ? <li className="tree-muted">暂无论文</li> : null}
          {papers === null && !error ? <li className="tree-muted">读取中…</li> : null}
        </ul>
      ) : null}
    </li>
  );
}
