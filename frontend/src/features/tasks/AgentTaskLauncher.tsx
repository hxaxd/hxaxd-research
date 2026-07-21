import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../../shared/api/client";
import type { Project, ProjectItem } from "../../shared/api/contracts";
import { useApiResource } from "../../shared/api/useApiResource";
import { Icon } from "../../shared/ui/Icon";

export function AgentTaskLauncher({ projects }: { projects: Project[] }) {
  const navigate = useNavigate();
  const [goal, setGoal] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [taskKind, setTaskKind] = useState("");
  const [items, setItems] = useState<ProjectItem[]>([]);
  const [itemId, setItemId] = useState("");
  const [zoteroPreviewId, setZoteroPreviewId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const definitions = useApiResource(() => api.agentTaskDefinitions(), []);
  const task = definitions.data?.find((definition) => definition.id === taskKind) ?? null;
  const isLiteratureSearch = task?.scope_requirement === "project";
  const isItemTask = task?.scope_requirement === "item";
  const isConflictTask = task?.scope_requirement === "zotero_preview";

  useEffect(() => {
    if (!definitions.data?.length || definitions.data.some((item) => item.id === taskKind)) return;
    setTaskKind(
      definitions.data.find((item) => item.ready)?.id ?? definitions.data[0]?.id ?? "",
    );
  }, [definitions.data, taskKind]);

  useEffect(() => {
    const projectStillExists = projects.some((project) => project.id === projectId);
    if ((isLiteratureSearch || isItemTask) && !projectStillExists) {
      setProjectId(projects[0]?.id ?? "");
    } else if (!isLiteratureSearch && !isItemTask && projectId && !projectStillExists) {
      setProjectId("");
    }
  }, [isItemTask, isLiteratureSearch, projectId, projects]);

  useEffect(() => {
    if (!isItemTask || !projectId) {
      setItems([]);
      setItemId("");
      return;
    }
    let active = true;
    void api.projectItems(projectId, "all").then((next) => {
      if (!active) return;
      setItems(next);
      setItemId((current) =>
        next.some((item) => item.preferred_item_id === current)
          ? current
          : (next[0]?.preferred_item_id ?? ""),
      );
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "无法读取项目文献");
    });
    return () => { active = false; };
  }, [isItemTask, projectId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!goal.trim()) return;
    if (!task?.ready) {
      setError(task?.missing_reason || "所选智能体任务当前尚未就绪。");
      return;
    }
    if (isLiteratureSearch && !projectId) {
      setError("文献检索必须先选择一个真实项目，候选结果才能进入正确的收件箱。");
      return;
    }
    if (isItemTask && (!projectId || !itemId)) {
      setError("元数据补全和资源获取必须绑定一篇项目文献。请先选择项目与文献。");
      return;
    }
    if (isConflictTask && !zoteroPreviewId.trim()) {
      setError("冲突分析必须绑定一个确定的 Zotero 传输预览。请填写预览 ID。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const launch = await api.createAgentRun({
        task_kind: taskKind,
        goal: goal.trim(),
        project_id: projectId || null,
        item_id: isItemTask ? itemId : null,
        zotero_preview_id: isConflictTask ? zoteroPreviewId.trim() : null,
      });
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
          <select value={taskKind} onChange={(event) => setTaskKind(event.target.value)} disabled={definitions.loading}>
            {definitions.data?.map((definition) => <option key={definition.id} value={definition.id}>{definition.label} · {definition.web_search ? "可检索网页" : "不使用网页"}{definition.ready ? "" : " · 未就绪"}</option>)}
          </select>
        </label>
        <label>
          <span>{isLiteratureSearch || isItemTask ? "目标项目（必选）" : "关联项目（可选）"}</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={(isLiteratureSearch || isItemTask) && projects.length === 0}>
            {!isLiteratureSearch && !isItemTask ? <option value="">整个工作区</option> : null}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        {isItemTask ? <label><span>目标文献（必选）</span><select value={itemId} onChange={(event) => setItemId(event.target.value)}><option value="">选择项目文献</option>{items.map((item) => <option key={item.id} value={item.preferred_item_id}>{item.translated_title || item.title}</option>)}</select></label> : null}
        {isConflictTask ? <label><span>Zotero 预览 ID（必选）</span><input value={zoteroPreviewId} onChange={(event) => setZoteroPreviewId(event.target.value)} placeholder="传输预览 ID" /></label> : null}
        <button className="primary-button" disabled={!goal.trim() || submitting || !task?.ready || (isLiteratureSearch && !projectId) || (isItemTask && !itemId) || (isConflictTask && !zoteroPreviewId.trim())} type="submit">
          <Icon name="arrow-right" size={15} />{submitting ? "正在启动…" : "创建独立运行"}
        </button>
      </div>
      <p className="launcher-capability-note">
        {definitions.error
          ? definitions.error
          : !task?.ready
            ? task?.missing_reason || "正在读取后端任务能力…"
            : isLiteratureSearch
          ? projects.length
            ? task.description
            : <><span>文献检索需要项目作用域。</span> <Link to="/?newProject=1">先创建项目</Link></>
          : isItemTask
            ? `${task.description} 后端会注入所选文献上下文；智能体只能提交待审阅建议。`
            : task.description}
      </p>
      {error ? <p className="inline-error">{error}</p> : null}
    </form>
  );
}
