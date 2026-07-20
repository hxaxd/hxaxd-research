import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import type { Paper, PaperStatus } from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";
import "./papers.css";

const statusLabels: Record<PaperStatus, string> = {
  discovered: "待判断",
  included: "已收录",
  excluded: "已排除",
  archived: "已归档",
};

const statusFilters: Array<{ label: string; value: "all" | PaperStatus }> = [
  { label: "全部", value: "all" },
  { label: "待判断", value: "discovered" },
  { label: "已收录", value: "included" },
  { label: "已排除", value: "excluded" },
  { label: "已归档", value: "archived" },
];

type SortMode = "year-desc" | "year-asc" | "updated-desc" | "title";

interface PaperLibraryProps {
  papers: Paper[];
}

export function PaperLibrary({ papers }: PaperLibraryProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | PaperStatus>("all");
  const [sort, setSort] = useState<SortMode>("year-desc");

  const counts = useMemo(() => {
    const result: Record<PaperStatus, number> = {
      discovered: 0,
      included: 0,
      excluded: 0,
      archived: 0,
    };
    for (const paper of papers) result[paper.status] += 1;
    return result;
  }, [papers]);

  const visiblePapers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const filtered = papers.filter((paper) => {
      if (status !== "all" && paper.status !== status) return false;
      if (!normalized) return true;
      return [
        paper.title_zh,
        paper.title_en,
        paper.authors.join(" "),
        paper.main_method,
        paper.contribution,
      ].some((value) => value.toLocaleLowerCase().includes(normalized));
    });
    return filtered.toSorted((left, right) => {
      if (sort === "year-desc") return right.publication_year - left.publication_year;
      if (sort === "year-asc") return left.publication_year - right.publication_year;
      if (sort === "updated-desc") return right.updated_at.localeCompare(left.updated_at);
      return left.title_zh.localeCompare(right.title_zh, "zh-CN");
    });
  }, [papers, query, sort, status]);

  return (
    <div className="paper-library">
      <div className="library-toolbar">
        <label className="paper-search">
          <Icon name="search" size={17} />
          <span className="visually-hidden">搜索论文</span>
          <input
            placeholder="搜索标题、作者、方法或贡献…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button aria-label="清空搜索" type="button" onClick={() => setQuery("")}>
              <Icon name="close" size={15} />
            </button>
          ) : null}
        </label>
        <label className="sort-control">
          <span>排序</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}>
            <option value="year-desc">最新发表</option>
            <option value="year-asc">最早发表</option>
            <option value="updated-desc">最近更新</option>
            <option value="title">标题</option>
          </select>
          <Icon name="chevron-down" size={14} />
        </label>
      </div>

      <div className="status-filters" aria-label="按状态筛选">
        {statusFilters.map((filter) => {
          const count = filter.value === "all" ? papers.length : counts[filter.value];
          return (
            <button
              key={filter.value}
              className={status === filter.value ? "status-filter active" : "status-filter"}
              type="button"
              onClick={() => setStatus(filter.value)}
            >
              {filter.label}<span>{count}</span>
            </button>
          );
        })}
      </div>

      <div className="library-summary">
        <span>显示 {visiblePapers.length} 篇论文</span>
        {query || status !== "all" ? (
          <button type="button" onClick={() => { setQuery(""); setStatus("all"); }}>
            重置筛选
          </button>
        ) : null}
      </div>

      {visiblePapers.length > 0 ? (
        <div className="paper-list" role="list">
          {visiblePapers.map((paper) => (
            <Link className="paper-list-item" key={paper.id} role="listitem" to={`/papers/${paper.id}`}>
              <div className="paper-year">{paper.publication_year}</div>
              <div className="paper-list-copy">
                <div className="paper-list-heading">
                  <h3>{paper.title_zh}</h3>
                  <span className={`status status--${paper.status}`}>{statusLabels[paper.status]}</span>
                </div>
                <p className="paper-english-title">{paper.title_en}</p>
                <div className="paper-meta-line">
                  <span>{paper.authors.slice(0, 3).join(", ")}{paper.authors.length > 3 ? " 等" : ""}</span>
                  {paper.organization ? <><i /> <span>{paper.organization}</span></> : null}
                </div>
                <p className="paper-contribution">{paper.contribution}</p>
              </div>
              <div className="paper-type-cell"><span className="tag">{paper.paper_type}</span></div>
              <Icon className="paper-open-icon" name="arrow-right" size={18} />
            </Link>
          ))}
        </div>
      ) : (
        <div className="library-empty">
          <span><Icon name="search" size={22} /></span>
          <h3>没有匹配的论文</h3>
          <p>换一个关键词，或者重置当前筛选条件。</p>
        </div>
      )}
    </div>
  );
}
