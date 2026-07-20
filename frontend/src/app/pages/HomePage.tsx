import { Link } from "react-router-dom";

import { useProjects } from "../../features/navigation/useProjects";
import { SnapshotPanel } from "../../features/snapshots/SnapshotPanel";
import { ToolPanel } from "../../features/tools/ToolPanel";
import { useWorkspace } from "../../features/tools/useWorkspace";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import { Icon } from "../../shared/ui/Icon";
import "./pages.css";

export function HomePage() {
  const { projects, loading, error } = useProjects();
  const { workspace } = useWorkspace();
  if (loading) return <AsyncMessage kind="loading">正在整理工作台…</AsyncMessage>;
  if (error) return <AsyncMessage kind="error">{error}</AsyncMessage>;

  const totalPapers = projects.reduce((sum, project) => sum + project.paper_count, 0);

  return (
    <section className="home-page">
      <div className="home-content">
        <header className="home-hero">
          <div className="hero-copy">
            <span className="eyebrow">RESEARCH LIBRARY</span>
            <h1>让论文真正进入你的学习流程</h1>
            <p>在一个安静、专注的工作台中完成论文筛选、阅读、翻译与沉淀。</p>
          </div>
          <div className="hero-orbit" aria-hidden="true">
            <span className="orbit-core"><Icon name="sparkles" size={28} /></span>
            <span className="orbit-dot orbit-dot--one" />
            <span className="orbit-dot orbit-dot--two" />
          </div>
        </header>

        <div className="home-stats">
          <div><span>学习项目</span><strong>{projects.length}</strong></div>
          <div><span>收集论文</span><strong>{totalPapers}</strong></div>
          <div><span>工作模式</span><strong className="status-online"><i />已连接</strong></div>
        </div>

        {workspace ? <div className="capability-strip" aria-label="平台能力">
          {Object.entries(workspace.capabilities).map(([name, capability]) => <div key={name}>
            <span>{name === "resource_upload" ? "资源获取" : name === "compile" ? "TeX 编译" : "PDF 翻译"}</span>
            <strong className={capability.ready ? "capability-ready" : "capability-missing"}>{capability.ready ? "已就绪" : capability.supported ? "工具未就绪" : "不支持"}</strong>
            <small>{capability.accepts.join(" / ")} → {capability.produces.join(" / ")}</small>
          </div>)}
        </div> : null}

        <div className="home-section-heading">
          <div><span className="eyebrow">YOUR PROJECTS</span><h2>继续学习</h2></div>
          <span>{projects.length} 个项目</span>
        </div>

        {projects.length > 0 ? (
          <div className="project-grid">
            {projects.map((project, index) => (
              <Link className="project-card" key={project.id} to={`/projects/${project.id}`}>
                <div className={`project-card-icon project-card-icon--${(index % 4) + 1}`}>
                  <Icon name="folder" size={22} />
                </div>
                <div className="project-card-copy">
                  <h3>{project.name}</h3>
                  <p>{project.description || "打开项目，查看已经收集的论文。"}</p>
                </div>
                <div className="project-card-footer">
                  <span><Icon name="file-text" size={14} />{project.paper_count} 篇论文</span>
                  <Icon className="card-arrow" name="arrow-right" size={18} />
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="home-empty">
            <Icon name="library" size={26} />
            <h2>从第一个学习项目开始</h2>
            <p>使用左侧的加号创建项目。</p>
          </div>
        )}

        <ToolPanel />
        <SnapshotPanel />
      </div>
    </section>
  );
}
