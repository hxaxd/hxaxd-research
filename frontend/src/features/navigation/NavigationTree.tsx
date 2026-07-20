import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";

import { Icon } from "../../shared/ui/Icon";
import { CreateProjectDialog } from "./CreateProjectDialog";
import { ProjectBranch } from "./ProjectBranch";
import { useProjects } from "./useProjects";
import "./navigation.css";

interface NavigationTreeProps {
  expanded: boolean;
  onToggle: () => void;
}

export function NavigationTree({ expanded, onToggle }: NavigationTreeProps) {
  const { projects, loading, error, createProject } = useProjects();
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const visibleProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return projects;
    return projects.filter((project) => project.name.toLocaleLowerCase().includes(normalized));
  }, [projects, query]);

  return (
    <>
      <nav className={expanded ? "navigation-tree" : "navigation-tree navigation-tree--collapsed"} aria-label="论文学习工作台">
        <div className="sidebar-brand">
          <NavLink className="brand-link" end title="论文学习工作台概览" to="/">
            <span className="brand-mark"><Icon name="library" size={21} /></span>
            <span className="brand-copy">
              <small>HXAXD LEARNING</small>
              <strong>学习工作台</strong>
            </span>
          </NavLink>
          <button
            aria-label={expanded ? "收起导航" : "展开导航"}
            className="sidebar-toggle"
            title={expanded ? "收起导航" : "展开导航"}
            type="button"
            onClick={onToggle}
          >
            <Icon name={expanded ? "chevron-left" : "panel-left"} size={18} />
          </button>
        </div>

        <NavLink className="overview-link" end title="概览" to="/">
          <Icon name="home" size={18} />
          <span>概览</span>
        </NavLink>

        <div className="sidebar-section-heading">
          <span>学习项目</span>
          <span className="section-count">{projects.length}</span>
          <button aria-label="新建项目" title="新建项目" type="button" onClick={() => setDialogOpen(true)}>
            <Icon name="plus" size={16} />
          </button>
        </div>

        <label className="nav-search">
          <Icon name="search" size={16} />
          <span className="visually-hidden">搜索项目</span>
          <input
            placeholder="搜索项目"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button aria-label="清空搜索" type="button" onClick={() => setQuery("")}>
              <Icon name="close" size={14} />
            </button>
          ) : null}
        </label>

        <div className="navigation-scroll">
          {loading ? <p className="tree-muted">读取项目中…</p> : null}
          {error ? <p className="tree-error">{error}</p> : null}
          <ul className="project-list">
            {visibleProjects.map((project) => (
              <ProjectBranch key={project.id} project={project} sidebarExpanded={expanded} />
            ))}
          </ul>
          {!loading && projects.length === 0 ? (
            <button className="empty-create" type="button" onClick={() => setDialogOpen(true)}>
              <Icon name="plus" size={17} />
              创建第一个学习项目
            </button>
          ) : null}
          {!loading && projects.length > 0 && visibleProjects.length === 0 ? (
            <p className="tree-muted">没有匹配的项目</p>
          ) : null}
        </div>

        <div className="sidebar-footer">
          <span className="service-indicator" />
          <span>本地服务已连接</span>
        </div>
      </nav>
      <CreateProjectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={createProject}
      />
    </>
  );
}
