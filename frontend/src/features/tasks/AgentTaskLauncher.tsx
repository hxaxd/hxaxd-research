import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../../shared/api/client";
import type { Project } from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";

export function AgentTaskLauncher({ projects }: { projects: Project[] }) {
  const navigate = useNavigate();
  const [goal, setGoal] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [taskKind, setTaskKind] = useState("literature_search");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLiteratureSearch = taskKind === "literature_search";

  useEffect(() => {
    const projectStillExists = projects.some((project) => project.id === projectId);
    if (isLiteratureSearch && !projectStillExists) {
      setProjectId(projects[0]?.id ?? "");
    } else if (!isLiteratureSearch && projectId && !projectStillExists) {
      setProjectId("");
    }
  }, [isLiteratureSearch, projectId, projects]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!goal.trim()) return;
    if (isLiteratureSearch && !projectId) {
      setError("文献检索必须先选择一个真实项目，候选结果才能进入正确的收件箱。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const launch = await api.createAgentRun({ task_kind: taskKind, goal: goal.trim(), project_id: projectId || null });
      navigate(`/agent-runs/${launch.run.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法启动智能体任务");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="agent-launcher" onSubmit={(event) => void submit(event)}>
      <div className="launcher-heading">
        <span className="launcher-icon"><Icon name="sparkles" size={20} /></span>
        <div><span className="eyebrow">NEW AGENT TASK</span><h2>告诉工作台你要完成什么</h2></div>
      </div>
      <textarea
        value={goal}
        placeholder="例如：检索最近两年的智能体长期记忆论文，把候选和来源证据放进当前项目。"
        onChange={(event) => setGoal(event.target.value)}
      />
      <div className="launcher-controls">
        <label>
          <span>任务类型</span>
          <select value={taskKind} onChange={(event) => setTaskKind(event.target.value)}>
            <option value="literature_search">文献检索 · 可使用网页搜索</option>
            <option value="metadata_enrichment">元数据补全 · 仅工作台内容</option>
            <option value="resource_acquisition">资源获取 · 仅工作台工具</option>
            <option value="conflict_resolution">冲突分析 · 仅工作台内容</option>
          </select>
        </label>
        <label>
          <span>{isLiteratureSearch ? "目标项目（必选）" : "作用域"}</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={isLiteratureSearch && projects.length === 0}>
            {!isLiteratureSearch ? <option value="">整个工作区</option> : null}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <button className="primary-button" disabled={!goal.trim() || submitting || (isLiteratureSearch && !projectId)} type="submit">
          <Icon name="arrow-right" size={15} />{submitting ? "正在启动…" : "创建独立运行"}
        </button>
      </div>
      <p className="launcher-capability-note">
        {isLiteratureSearch
          ? projects.length
            ? "文献检索会启用网页搜索，并把候选与来源证据暂存到所选项目；最终判断仍由你完成。"
            : <><span>文献检索需要项目作用域。</span> <Link to="/?newProject=1">先创建项目</Link></>
          : "此任务不会启用网页搜索，只会使用后端注入的工作台上下文和已授权工具。"}
      </p>
      {error ? <p className="inline-error">{error}</p> : null}
    </form>
  );
}
