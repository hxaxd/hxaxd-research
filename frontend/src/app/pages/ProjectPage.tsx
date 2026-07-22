import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { CandidateInbox } from "../../features/candidates/CandidateInbox";
import { useAppData } from "../AppDataContext";
import { api } from "../../shared/api/client";
import type { CandidateDecision, ProjectItem, ProjectItemStatus } from "../../shared/api/contracts";
import { useApiResource } from "../../shared/api/useApiResource";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import { Icon } from "../../shared/ui/Icon";
import "./pages.css";

type ProjectTab = "candidates" | "library";

export function ProjectPage() {
  const { refresh: refreshWorkspace } = useAppData();
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [deciding, setDeciding] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const requestedTab = params.get("tab") as ProjectTab | null;
  const status = (params.get("status") as ProjectItemStatus | null) ?? "included";
  const resource = useApiResource(
    () => projectId ? Promise.all([
      api.project(projectId),
      api.candidates(projectId, ["staged", "matched"]),
      api.projectItems(projectId, "all"),
    ]) : Promise.reject(new Error("项目地址无效")),
    [projectId],
  );

  if (resource.loading) return <AsyncMessage kind="loading">正在读取项目…</AsyncMessage>;
  if (resource.error) return <AsyncMessage kind="error" onRetry={() => void resource.retry()}>{resource.error}</AsyncMessage>;
  if (!projectId || !resource.data) return <AsyncMessage kind="empty">项目不存在</AsyncMessage>;
  const validProjectId = projectId;
  const [project, candidates, items] = resource.data;
  const pending = project.candidate_count;
  const tab = requestedTab ?? (pending > 0 ? "candidates" : "library");

  async function decide(
    decisions: CandidateDecision[],
    options?: { openIncluded?: boolean },
  ) {
    setDeciding(decisions.length === 1 ? decisions[0]?.candidate_id ?? null : "batch");
    setDecisionError(null);
    try {
      const results = await api.decideCandidates(validProjectId, decisions);
      const includedIndex = options?.openIncluded
        ? decisions.findIndex((decision) => decision.decision === "include")
        : -1;
      const target = includedIndex >= 0
        ? candidateDecisionTarget(validProjectId, decisions[includedIndex]!, results[includedIndex])
        : null;
      await refreshWorkspace();
      if (target) {
        navigate(target);
        return;
      }
      await resource.reload();
    } catch (reason) {
      setDecisionError(reason instanceof Error ? reason.message : "无法提交候选判断");
    } finally {
      setDeciding(null);
    }
  }

  function selectTab(next: ProjectTab) {
    setParams((current) => {
      current.set("tab", next);
      return current;
    });
  }

  return (
    <section className="project-page workspace-page">
      <div className="workspace-content">
        <header className="page-header compact-page-header">
          <div><div className="breadcrumb"><Link to="/">工作台</Link><Icon name="chevron-right" size={13} /><span>项目</span></div><h1>{project.name}</h1><p>{project.description || "尚未填写项目范围"}</p></div>
          <div className="header-metrics"><span><small>文献</small><strong>{project.work_count}</strong></span><span className={pending ? "metric-warning" : ""}><small>待判断</small><strong>{pending}</strong></span></div>
        </header>
        <nav className="page-tabs" aria-label="项目视图">
          <button className={tab === "candidates" ? "active" : ""} type="button" onClick={() => selectTab("candidates")}><Icon name="inbox" size={15} />候选收件箱{pending ? <em>{pending}</em> : null}</button>
          <button className={tab === "library" ? "active" : ""} type="button" onClick={() => selectTab("library")}><Icon name="library" size={15} />项目文献</button>
        </nav>
        {decisionError ? <div className="page-error">{decisionError}</div> : null}
        {tab === "candidates" ? <CandidateInbox candidates={candidates} deciding={deciding} onDecisions={decide} /> : <ProjectLibrary projectId={projectId} items={items} status={status} onStatus={(next) => setParams({ tab: "library", status: next })} />}
      </div>
    </section>
  );
}

export function candidateDecisionTarget(
  projectId: string,
  decision: CandidateDecision,
  result: { project_item: ProjectItem | null } | undefined,
): string | null {
  if (decision.decision !== "include" || !result?.project_item) return null;
  return `/projects/${projectId}/items/${result.project_item.preferred_item_id}`;
}

function ProjectLibrary({ projectId, items, status, onStatus }: { projectId: string; items: ProjectItem[]; status: ProjectItemStatus; onStatus: (status: ProjectItemStatus) => void }) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return items.filter((item) => item.status === status && (!normalized || [item.title, item.translated_title ?? "", item.summary ?? "", item.relevance ?? ""].some((value) => value.toLocaleLowerCase().includes(normalized))));
  }, [items, query, status]);
  const statuses: Array<{ value: ProjectItemStatus; label: string }> = [
    { value: "included", label: "已收录" },
    { value: "discovered", label: "待判断" },
    { value: "excluded", label: "已排除" },
    { value: "archived", label: "已归档" },
  ];
  return <section className="project-library"><div className="library-controls"><label><Icon name="search" size={16} /><input placeholder="搜索标题、项目摘要或相关性" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div>{statuses.map((item) => <button className={status === item.value ? "active" : ""} key={item.value} type="button" onClick={() => onStatus(item.value)}>{item.label}<span>{items.filter((entry) => entry.status === item.value).length}</span></button>)}</div></div>{visible.length ? <div className="project-item-list">{visible.map((item) => <Link key={item.id} to={`/projects/${projectId}/items/${item.preferred_item_id}`}><span className="item-year">{item.issued_year ?? "—"}</span><span className="item-copy"><strong>{item.translated_title || item.title}</strong>{item.translated_title ? <small>{item.title}</small> : null}<em>{item.summary || item.relevance || "尚未补充项目判断"}</em></span><span className="item-roles">{item.roles.map((role) => <i key={role}>{role}</i>)}</span><Icon name="arrow-right" size={17} /></Link>)}</div> : <div className="library-empty"><Icon name="search" size={22} /><h3>没有匹配的文献</h3><p>切换状态或修改关键词。</p></div>}</section>;
}
