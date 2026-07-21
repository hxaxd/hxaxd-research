import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../../shared/api/client";
import type { Project, ProjectItem } from "../../shared/api/contracts";
import { useApiResource } from "../../shared/api/useApiResource";
import { Icon } from "../../shared/ui/Icon";

interface FixedItemScope {
  projectId: string;
  itemId: string;
  label: string;
}

interface Props {
  projects?: Project[];
  fixedItemScope?: FixedItemScope;
}

export function AgentTaskLauncher({ projects = [], fixedItemScope }: Props) {
  const navigate = useNavigate();
  const [goal, setGoal] = useState("");
  const [projectId, setProjectId] = useState(
    fixedItemScope?.projectId ?? projects[0]?.id ?? "",
  );
  const [taskKind, setTaskKind] = useState("");
  const [items, setItems] = useState<ProjectItem[]>([]);
  const [itemId, setItemId] = useState(fixedItemScope?.itemId ?? "");
  const [zoteroPreviewId, setZoteroPreviewId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const definitions = useApiResource(() => api.agentTaskDefinitions(), []);
  const availableDefinitions = useMemo(
    () => definitions.data?.filter(
      (definition) => !fixedItemScope || definition.scope_requirement === "item",
    ) ?? [],
    [definitions.data, fixedItemScope],
  );
  const task = availableDefinitions.find((definition) => definition.id === taskKind) ?? null;
  const isLiteratureSearch = task?.scope_requirement === "project";
  const isItemTask = task?.scope_requirement === "item";
  const isConflictTask = task?.scope_requirement === "zotero_preview";

  useEffect(() => {
    if (!availableDefinitions.length || availableDefinitions.some((item) => item.id === taskKind)) return;
    setTaskKind(
      availableDefinitions.find((item) => item.ready)?.id ?? availableDefinitions[0]?.id ?? "",
    );
  }, [availableDefinitions, taskKind]);

  useEffect(() => {
    if (!fixedItemScope) return;
    setProjectId(fixedItemScope.projectId);
    setItemId(fixedItemScope.itemId);
  }, [fixedItemScope]);

  useEffect(() => {
    if (fixedItemScope) return;
    const projectStillExists = projects.some((project) => project.id === projectId);
    if ((isLiteratureSearch || isItemTask) && !projectStillExists) {
      setProjectId(projects[0]?.id ?? "");
    } else if (!isLiteratureSearch && !isItemTask && projectId && !projectStillExists) {
      setProjectId("");
    }
  }, [fixedItemScope, isItemTask, isLiteratureSearch, projectId, projects]);

  useEffect(() => {
    if (fixedItemScope) {
      setItems([]);
      return;
    }
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
  }, [fixedItemScope, isItemTask, projectId]);

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
    <form className={fixedItemScope ? "agent-launcher agent-launcher--item" : "agent-launcher"} onSubmit={(event) => void submit(event)}>
      <div className="launcher-heading">
        <span className="launcher-icon"><Icon name="sparkles" size={20} /></span>
        <div><span className="eyebrow">NEW AGENT TASK</span><h2>{fixedItemScope ? "补全当前文献" : "告诉工作台你要完成什么"}</h2></div>
      </div>
      <textarea
        value={goal}
        placeholder={fixedItemScope ? "例如：核对出版者页面和 DOI，提出元数据修订建议。" : "例如：检索最近两年的智能体长期记忆论文，把候选和来源证据放进当前项目。"}
        onChange={(event) => setGoal(event.target.value)}
      />
      <div className="launcher-controls">
        <label>
          <span>任务类型</span>
          <select value={taskKind} onChange={(event) => setTaskKind(event.target.value)} disabled={definitions.loading}>
            {availableDefinitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.label} · {definition.web_search ? "可检索网页" : "不使用网页"}{definition.ready ? "" : " · 未就绪"}</option>)}
          </select>
        </label>
        {fixedItemScope ? <div className="launcher-fixed-scope"><span>当前文献</span><strong>{fixedItemScope.label}</strong><small>项目与文献标识由页面固定，不能跨作用域提交。</small></div> : <label>
          <span>{isLiteratureSearch || isItemTask ? "目标项目（必选）" : "关联项目（可选）"}</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={(isLiteratureSearch || isItemTask) && projects.length === 0}>
            {!isLiteratureSearch && !isItemTask ? <option value="">整个工作区</option> : null}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>}
        {isItemTask && !fixedItemScope ? <label><span>目标文献（必选）</span><select value={itemId} onChange={(event) => setItemId(event.target.value)}><option value="">选择项目文献</option>{items.map((item) => <option key={item.id} value={item.preferred_item_id}>{item.translated_title || item.title}</option>)}</select></label> : null}
        {isConflictTask ? <label><span>Zotero 预览 ID（必选）</span><input value={zoteroPreviewId} onChange={(event) => setZoteroPreviewId(event.target.value)} placeholder="传输预览 ID" /></label> : null}
        <button className="primary-button" disabled={!goal.trim() || submitting || !task?.ready || (isLiteratureSearch && !projectId) || (isItemTask && !itemId) || (isConflictTask && !zoteroPreviewId.trim())} type="submit">
          <Icon name="arrow-right" size={15} />{submitting ? "正在启动…" : "创建独立运行"}
        </button>
      </div>
      <p className="launcher-capability-note">
        {definitions.error
          ? <>{definitions.error} <button type="button" onClick={() => void definitions.retry()}>重新读取能力</button></>
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
