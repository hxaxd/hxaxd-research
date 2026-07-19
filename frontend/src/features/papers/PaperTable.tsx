import { Link } from "react-router-dom";

import type { Paper } from "../../shared/api/contracts";
import "./papers.css";

const statusLabels = {
  discovered: "待判断",
  included: "已收录",
  excluded: "已排除",
  archived: "已归档",
} as const;

interface PaperTableProps {
  papers: Paper[];
}

export function PaperTable({ papers }: PaperTableProps) {
  return (
    <div className="paper-table-wrap">
      <table className="paper-table">
        <thead>
          <tr>
            <th>论文</th>
            <th>年份</th>
            <th>类型</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {papers.map((paper) => (
            <tr key={paper.id}>
              <td>
                <Link className="paper-title-link" to={`/papers/${paper.id}`}>
                  <strong>{paper.title_zh}</strong>
                  <span>{paper.title_en}</span>
                </Link>
                <div className="paper-authors">{paper.authors.join(", ")}</div>
              </td>
              <td>{paper.publication_year}</td>
              <td>
                <span className="tag">{paper.paper_type}</span>
              </td>
              <td>
                <span className={`status status--${paper.status}`}>{statusLabels[paper.status]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
