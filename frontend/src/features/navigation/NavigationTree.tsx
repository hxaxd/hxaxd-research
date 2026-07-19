import { ProjectBranch } from "./ProjectBranch";
import { useProjects } from "./useProjects";
import "./navigation.css";

export function NavigationTree() {
  const { projects, loading, error, createProject } = useProjects();

  async function addProject() {
    const name = window.prompt("项目名称");
    if (name?.trim()) await createProject(name.trim());
  }

  return (
    <nav className="navigation-tree" aria-label="学习项目">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">WORKSPACE</span>
          <h1>学习</h1>
        </div>
        <button className="icon-button" type="button" title="新建项目" onClick={() => void addProject()}>
          ＋
        </button>
      </div>
      {loading ? <p className="tree-muted">读取中…</p> : null}
      {error ? <p className="tree-error">{error}</p> : null}
      <ul className="project-list">
        {projects.map((project) => (
          <ProjectBranch key={project.id} project={project} />
        ))}
      </ul>
      {!loading && projects.length === 0 ? (
        <button className="empty-create" type="button" onClick={() => void addProject()}>
          创建第一个学习项目
        </button>
      ) : null}
    </nav>
  );
}
