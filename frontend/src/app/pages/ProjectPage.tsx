import { useParams } from "react-router-dom";

import { Link } from "react-router-dom";

import { PaperLibrary } from "../../features/papers/PaperLibrary";
import { useProjectPapers } from "../../features/papers/useProjectPapers";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import { Icon } from "../../shared/ui/Icon";
import "./pages.css";

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return <AsyncMessage kind="error">项目地址无效</AsyncMessage>;
  return <ProjectContent projectId={projectId} />;
}

function ProjectContent({ projectId }: { projectId: string }) {
  const { project, papers, loading, error } = useProjectPapers(projectId);
  if (loading) return <AsyncMessage kind="loading">正在读取论文…</AsyncMessage>;
  if (error) return <AsyncMessage kind="error">{error}</AsyncMessage>;
  if (!project) return <AsyncMessage kind="empty">项目不存在</AsyncMessage>;

  const included = papers.filter((paper) => paper.status === "included").length;
  const discovered = papers.filter((paper) => paper.status === "discovered").length;
  const years = papers.map((paper) => paper.publication_year).filter(Boolean);
  const yearRange = years.length > 0 ? `${Math.min(...years)} — ${Math.max(...years)}` : "—";

  return (
    <section className="project-page">
      <div className="project-content">
        <header className="page-header">
          <div className="page-heading-copy">
            <div className="breadcrumb"><Link to="/">学习</Link><Icon name="chevron-right" size={13} /><span>项目</span></div>
            <h1>{project.name}</h1>
            <p>{project.description || "尚未填写项目范围"}</p>
          </div>
          <div className="project-mark"><Icon name="book-open" size={26} /></div>
        </header>

        <div className="project-metrics" aria-label="项目统计">
          <div className="metric-card metric-card--primary">
            <span>论文总数</span><strong>{papers.length}</strong>
          </div>
          <div className="metric-card">
            <span>已收录</span><strong>{included}</strong>
          </div>
          <div className="metric-card">
            <span>待判断</span><strong>{discovered}</strong>
          </div>
          <div className="metric-card metric-card--range">
            <span>发表年份</span><strong>{yearRange}</strong>
          </div>
        </div>

        {papers.length > 0 ? (
          <PaperLibrary papers={papers} />
        ) : (
          <div className="project-empty">
            <span><Icon name="file-text" size={24} /></span>
            <h2>项目里还没有论文</h2>
            <p>Agent 提交候选论文后，它们会直接出现在这里。</p>
          </div>
        )}
      </div>
    </section>
  );
}
