import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import type { PaperStatus, ProjectPaperView } from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";
import "./papers.css";

const statusLabels: Record<PaperStatus, string> = {
  discovered: "待判断", included: "已收录", excluded: "已排除", archived: "已归档",
};
const statusFilters: Array<{ label: string; value: "all" | PaperStatus }> = [
  { label: "全部", value: "all" }, { label: "待判断", value: "discovered" },
  { label: "已收录", value: "included" }, { label: "已排除", value: "excluded" },
  { label: "已归档", value: "archived" },
];
type SortMode = "year-desc" | "year-asc" | "updated-desc" | "title";

export function PaperLibrary({ papers }: { papers: ProjectPaperView[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | PaperStatus>("all");
  const [role, setRole] = useState("all");
  const [year, setYear] = useState("all");
  const [resource, setResource] = useState("all");
  const [sort, setSort] = useState<SortMode>("year-desc");
  const counts = useMemo(() => {
    const result: Record<PaperStatus, number> = { discovered: 0, included: 0, excluded: 0, archived: 0 };
    for (const entry of papers) result[entry.project.status] += 1;
    return result;
  }, [papers]);
  const roles = useMemo(() => [...new Set(papers.flatMap((entry) => entry.project.roles))], [papers]);
  const years = useMemo(() => [...new Set(papers.map((entry) => entry.paper.publication_year).filter((item): item is number => item !== null))].toSorted((a, b) => b - a), [papers]);
  const visiblePapers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return papers.filter((entry) => {
      const { paper, project } = entry;
      if (status !== "all" && project.status !== status) return false;
      if (role !== "all" && !project.roles.some((item) => item === role)) return false;
      if (year !== "all" && paper.publication_year !== Number(year)) return false;
      if (resource !== "all" && !entry.resources.some((item) => item.format === resource)) return false;
      if (!normalized) return true;
      return [paper.title_zh ?? "", paper.title, paper.authors.join(" "), project.summary ?? "", project.relevance ?? ""]
        .some((value) => value.toLocaleLowerCase().includes(normalized));
    }).toSorted((left, right) => {
      if (sort === "year-desc") return (right.paper.publication_year ?? 0) - (left.paper.publication_year ?? 0);
      if (sort === "year-asc") return (left.paper.publication_year ?? 0) - (right.paper.publication_year ?? 0);
      if (sort === "updated-desc") return right.project.updated_at.localeCompare(left.project.updated_at);
      return (left.paper.title_zh ?? left.paper.title).localeCompare(right.paper.title_zh ?? right.paper.title, "zh-CN");
    });
  }, [papers, query, resource, role, sort, status, year]);

  return <div className="paper-library">
    <div className="library-toolbar">
      <label className="paper-search"><Icon name="search" size={17} /><span className="visually-hidden">搜索论文</span>
        <input placeholder="搜索标题、作者、摘要或相关性…" value={query} onChange={(event) => setQuery(event.target.value)} />
        {query ? <button aria-label="清空搜索" type="button" onClick={() => setQuery("")}><Icon name="close" size={15} /></button> : null}
      </label>
      <label className="sort-control"><span>角色</span><select value={role} onChange={(event) => setRole(event.target.value)}><option value="all">全部</option>{roles.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label className="sort-control"><span>年份</span><select value={year} onChange={(event) => setYear(event.target.value)}><option value="all">全部</option>{years.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label className="sort-control"><span>资源</span><select value={resource} onChange={(event) => setResource(event.target.value)}><option value="all">全部</option><option value="pdf">PDF</option><option value="tex">TeX</option></select></label>
      <label className="sort-control"><span>排序</span><select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}><option value="year-desc">最新发表</option><option value="year-asc">最早发表</option><option value="updated-desc">最近更新</option><option value="title">标题</option></select></label>
    </div>
    <div className="status-filters" aria-label="按状态筛选">{statusFilters.map((filter) => <button key={filter.value} className={status === filter.value ? "status-filter active" : "status-filter"} type="button" onClick={() => setStatus(filter.value)}>{filter.label}<span>{filter.value === "all" ? papers.length : counts[filter.value]}</span></button>)}</div>
    <div className="library-summary"><span>显示 {visiblePapers.length} 篇论文</span></div>
    {visiblePapers.length ? <div className="paper-list" role="list">{visiblePapers.map(({ paper, project, resources }) => <Link className="paper-list-item" key={project.id} role="listitem" to={`/papers/${paper.id}`}>
      <div className="paper-year">{paper.publication_year ?? "—"}</div><div className="paper-list-copy"><div className="paper-list-heading"><h3>{paper.title_zh || paper.title}</h3><span className={`status status--${project.status}`}>{statusLabels[project.status]}</span></div>
      <p className="paper-english-title">{paper.title}</p><div className="paper-meta-line"><span>{paper.authors.slice(0, 3).join(", ")}{!paper.authors_complete ? " 等" : ""}</span>{paper.venue ? <><i /><span>{paper.venue}</span></> : null}</div><p className="paper-contribution">{project.summary || project.relevance || "尚未补充项目判断"}</p></div>
      <div className="paper-type-cell"><div>{project.roles.map((item) => <span className="tag" key={item}>{item}</span>)}</div><div className="resource-badges">{[...new Set(resources.map((item) => item.format === "tex" ? "TeX" : item.representation === "original" ? "PDF" : item.representation === "translated" ? "中文" : "双语"))].map((item) => <span key={item}>{item}</span>)}</div></div><Icon className="paper-open-icon" name="arrow-right" size={18} />
    </Link>)}</div> : <div className="library-empty"><span><Icon name="search" size={22} /></span><h3>没有匹配的论文</h3><p>换一个关键词或筛选条件。</p></div>}
  </div>;
}
