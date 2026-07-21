import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { useAppData } from "../AppDataContext";
import { AgentTaskLauncher } from "../../features/tasks/AgentTaskLauncher";
import { api } from "../../shared/api/client";
import { useApiResource } from "../../shared/api/useApiResource";
import { formatDateTime } from "../../shared/lib/format";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import { Icon } from "../../shared/ui/Icon";
import "./pages.css";

export function HomePage() {
  const { projects, workspace, loading, connection, error } = useAppData();
  const [searchParams, setSearchParams] = useSearchParams();
  const activity = useApiResource(() => Promise.all([api.jobs(), api.agentRuns()]), []);
  if (loading) return <AsyncMessage kind="loading">正在整理工作台…</AsyncMessage>;

  const totalWorks = projects.reduce((sum, project) => sum + project.work_count, 0);
  const pending = projects.reduce(
    (sum, project) => sum + (project.status_counts.discovered ?? 0),
    0,
  );
  const pendingProject = projects.find(
    (project) => (project.status_counts.discovered ?? 0) > 0,
  );
  const jobs = activity.data?.[0] ?? [];
  const runs = activity.data?.[1] ?? [];
  const active = [
    ...runs.filter((run) =>
      ["created", "starting", "running", "waiting_approval"].includes(run.status),
    ),
    ...jobs.filter((job) =>
      ["queued", "running", "cancellation_requested"].includes(job.status),
    ),
  ];
  const creatingProject = searchParams.get("newProject") === "1";

  function setCreatingProject(open: boolean) {
    const next = new URLSearchParams(searchParams);
    if (open) next.set("newProject", "1");
    else next.delete("newProject");
    setSearchParams(next, { replace: true });
  }

  return (
    <section className="home-page workspace-page">
      <div className="workspace-content">
        <header className="dashboard-hero">
          <div>
            <span className="eyebrow">LITERATURE INDEX</span>
            <h1>从候选到阅读，保持每一步清晰</h1>
            <p>检索结果先进入收件箱；你的判断、智能体行动和后台任务都有独立记录。</p>
          </div>
          <div className={`connection-card connection-card--${connection}`}>
            <span><i />{connection === "connected" ? "后端已连接" : connection === "connecting" ? "正在连接" : "后端未连接"}</span>
            <small>{workspace ? `契约 ${workspace.contract_version} · Schema ${workspace.schema_version}` : error || "等待工作区响应"}</small>
          </div>
        </header>

        <div className="dashboard-metrics">
          <Link to={pendingProject ? `/projects/${pendingProject.id}` : "/"}>
            <span>待判断候选</span><strong className={pending ? "warning-number" : ""}>{pending}</strong><small>需要你的明确决定</small>
          </Link>
          <div><span>项目</span><strong>{projects.length}</strong><small>相互独立的学习范围</small></div>
          <div><span>项目文献关系</span><strong>{totalWorks}</strong><small>跨项目关系分别计数</small></div>
          <Link to="/tasks"><span>活跃任务</span><strong>{active.length}</strong><small>运行、等待与审批</small></Link>
        </div>

        <AgentTaskLauncher projects={projects} />

        <div className="dashboard-grid">
          <section className="dashboard-section">
            <header>
              <div><span className="eyebrow">PROJECTS</span><h2>项目入口</h2></div>
              <button className="project-create-button" type="button" onClick={() => setCreatingProject(!creatingProject)}>
                <Icon name={creatingProject ? "close" : "plus"} size={14} />
                {creatingProject ? "取消" : "创建项目"}
              </button>
            </header>
            {creatingProject ? <ProjectCreator /> : null}
            <div className="compact-project-list">
              {projects.map((project) => (
                <Link key={project.id} to={`/projects/${project.id}`}>
                  <span className="project-list-icon"><Icon name="folder" size={18} /></span>
                  <span><strong>{project.name}</strong><small>{project.description || "尚未填写项目范围"}</small></span>
                  <em>{project.status_counts.discovered ? `${project.status_counts.discovered} 待判断` : `${project.work_count} 篇`}</em>
                  <Icon name="arrow-right" size={16} />
                </Link>
              ))}
              {!projects.length && !creatingProject ? (
                <button className="project-list-empty" type="button" onClick={() => setCreatingProject(true)}>
                  <Icon name="plus" size={17} />创建第一个项目，定义文献检索范围
                </button>
              ) : null}
            </div>
          </section>

          <section className="dashboard-section">
            <header><div><span className="eyebrow">ACTIVITY</span><h2>正在进行</h2></div><Link to="/tasks">全部任务</Link></header>
            <div className="activity-list">
              {active.slice(0, 6).map((entry) => "goal" in entry ? (
                <Link key={entry.id} to={`/agent-runs/${entry.id}`}>
                  <span className={`task-dot task-dot--${entry.status}`} />
                  <span><strong>{entry.goal}</strong><small>{entry.status} · {formatDateTime(entry.updated_at)}</small></span>
                </Link>
              ) : (
                <Link key={entry.id} to="/tasks">
                  <span className={`task-dot task-dot--${entry.status}`} />
                  <span><strong>{entry.kind}</strong><small>{entry.status} · {formatDateTime(entry.updated_at)}</small></span>
                </Link>
              ))}
              {!active.length ? <div className="activity-empty"><Icon name="check" size={18} />当前没有运行中的任务</div> : null}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

function ProjectCreator() {
  const { createProject } = useAppData();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const project = await createProject({ name: normalizedName, description: description.trim() });
      navigate(`/projects/${project.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建项目");
      setSubmitting(false);
    }
  }

  return (
    <form className="project-create-panel" onSubmit={(event) => void submit(event)}>
      <label><span>项目名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：智能体长期记忆" /></label>
      <label><span>范围说明</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="写清主题、时间范围或筛选边界" /></label>
      <button className="primary-button" type="submit" disabled={!name.trim() || submitting}>
        <Icon name="arrow-right" size={14} />{submitting ? "正在创建…" : "创建并进入"}
      </button>
      {error ? <p className="inline-error">{error}</p> : null}
    </form>
  );
}
