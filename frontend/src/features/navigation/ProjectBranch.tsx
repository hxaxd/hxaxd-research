import { useState } from "react";
import { NavLink } from "react-router-dom";

import { api } from "../../shared/api/client";
import type { Paper, ProjectSummary } from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";

interface ProjectBranchProps {
  project: ProjectSummary;
  sidebarExpanded: boolean;
}

export function ProjectBranch({ project, sidebarExpanded }: ProjectBranchProps) {
  const [branchOpen, setBranchOpen] = useState(false);
  const [papers, setPapers] = useState<Paper[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !branchOpen;
    setBranchOpen(next);
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
        {sidebarExpanded ? (
          <button
            className="tree-toggle"
            type="button"
            aria-label={branchOpen ? "收起项目" : "展开项目"}
            onClick={() => void toggle()}
          >
            <Icon name={branchOpen ? "chevron-down" : "chevron-right"} size={14} />
          </button>
        ) : null}
        <NavLink className="project-link" to={`/projects/${project.id}`} title={project.name}>
          <Icon className="project-folder" name="folder" size={17} />
          <span className="project-link-copy">{project.name}</span>
          <span className="tree-count">{project.paper_count}</span>
        </NavLink>
      </div>
      {sidebarExpanded && branchOpen ? (
        <ul className="tree-paper-list">
          {error ? <li className="tree-error">{error}</li> : null}
          {papers?.map((paper) => (
            <li key={paper.id}>
              <NavLink to={`/papers/${paper.id}`} title={paper.title_zh}>
                <Icon name="file-text" size={14} />
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
