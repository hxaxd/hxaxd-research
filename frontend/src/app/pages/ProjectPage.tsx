import { useParams } from "react-router-dom";

import { PaperTable } from "../../features/papers/PaperTable";
import { useProjectPapers } from "../../features/papers/useProjectPapers";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";

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

  return (
    <section className="project-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">PROJECT</span>
          <h2>{project.name}</h2>
          <p>{project.description || "尚未填写项目范围"}</p>
        </div>
        <div className="metric-card">
          <strong>{papers.length}</strong>
          <span>篇论文</span>
        </div>
      </header>
      {papers.length > 0 ? (
        <PaperTable papers={papers} />
      ) : (
        <AsyncMessage kind="empty">Agent 提交论文后，它们会直接出现在这里。</AsyncMessage>
      )}
    </section>
  );
}

