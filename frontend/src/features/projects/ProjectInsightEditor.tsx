import { useEffect, useState } from "react";

import { api } from "../../shared/api/client";
import type { ProjectItem, ProjectItemStatus } from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";
import "./project-insights.css";

export function ProjectInsightEditor({ projectId, initial }: { projectId: string; initial: ProjectItem }) {
  const [projectItem, setProjectItem] = useState(initial);
  const [status, setStatus] = useState<ProjectItemStatus>(initial.status);
  const [roles, setRoles] = useState(initial.roles.join(", "));
  const [summary, setSummary] = useState(initial.summary ?? "");
  const [relevance, setRelevance] = useState(initial.relevance ?? "");
  const [contributions, setContributions] = useState(initial.contributions.join("\n"));
  const [readingFocus, setReadingFocus] = useState(initial.reading_focus.join("\n"));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setProjectItem(initial);
    setStatus(initial.status);
    setRoles(initial.roles.join(", "));
    setSummary(initial.summary ?? "");
    setRelevance(initial.relevance ?? "");
    setContributions(initial.contributions.join("\n"));
    setReadingFocus(initial.reading_focus.join("\n"));
  }, [initial]);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await api.updateProjectItem(projectId, projectItem.work_id, {
        status,
        roles: splitValues(roles, /[,，\n]/),
        summary: summary.trim() || null,
        relevance: relevance.trim() || null,
        contributions: splitValues(contributions, /\n/),
        reading_focus: splitValues(readingFocus, /\n/),
      });
      setProjectItem(updated);
      setMessage("项目判断已保存");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "项目判断保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="project-insight-editor">
      <header><div><span className="eyebrow">PROJECT READING</span><h2>项目判断</h2></div><span>{projectItem.status}</span></header>
      <label><span>状态</span><select aria-label="项目状态" value={status} onChange={(event) => setStatus(event.target.value as ProjectItemStatus)}><option value="discovered">待判断</option><option value="included">已收录</option><option value="excluded">已排除</option><option value="archived">已归档</option></select></label>
      <label><span>角色</span><input aria-label="项目角色" placeholder="核心论文, 方法" value={roles} onChange={(event) => setRoles(event.target.value)} /></label>
      <label><span>项目摘要</span><textarea aria-label="项目摘要" value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
      <label><span>相关性</span><textarea aria-label="相关性" value={relevance} onChange={(event) => setRelevance(event.target.value)} /></label>
      <label><span>主要贡献（每行一条）</span><textarea aria-label="主要贡献" value={contributions} onChange={(event) => setContributions(event.target.value)} /></label>
      <label><span>阅读重点（每行一条）</span><textarea aria-label="阅读重点" value={readingFocus} onChange={(event) => setReadingFocus(event.target.value)} /></label>
      <button className="primary-button" disabled={busy} type="button" onClick={() => void save()}><Icon name="check" size={15} />{busy ? "正在保存…" : "保存项目判断"}</button>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}

export function splitValues(value: string, separator: RegExp): string[] {
  return value.split(separator).map((item) => item.trim()).filter(Boolean);
}
