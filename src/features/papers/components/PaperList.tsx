'use client';

import { BookOpen, Folder } from 'lucide-react';

import { requestJson } from '@/shared/http/request-json';
import { InlineName } from '@/shared/ui/InlineName';

import type { Paper } from '../schema';

export function PaperList({
  papers,
  activeId,
  workspaceId,
  onSelect,
  onRenamed,
}: {
  papers: Paper[];
  activeId: string | null;
  workspaceId: string;
  onSelect: (id: string | null) => void;
  onRenamed: (paper: Paper) => void;
}) {
  return (
    <div className="paper-list">
      {papers.map((paper) => (
        <div
          key={paper.id}
          className={`paper-row ${activeId === paper.id ? 'selected' : ''}`}
        >
          <button
            className={
              activeId === paper.id ? 'paper-icon icon-button' : 'paper-select'
            }
            aria-label={
              activeId === paper.id ? `选择论文 ${paper.name}` : undefined
            }
            aria-pressed={activeId === paper.id}
            title={paper.name}
            onClick={() => onSelect(paper.id)}
          >
            <BookOpen size={16} />
            {activeId !== paper.id && <span>{paper.name}</span>}
          </button>
          {activeId === paper.id && (
            <InlineName
              className="paper-name"
              name={paper.name}
              label="论文名称"
              onRename={async (name) =>
                onRenamed(
                  await requestJson<Paper>(
                    `/api/workspaces/${workspaceId}/papers/${paper.id}`,
                    {
                      method: 'PATCH',
                      body: JSON.stringify({ name }),
                    },
                  ),
                )
              }
            />
          )}
        </div>
      ))}
      <button
        className={`public-materials ${activeId === null ? 'selected' : ''}`}
        aria-pressed={activeId === null}
        onClick={() => onSelect(null)}
      >
        <Folder size={16} />
        <span>工作区文件</span>
      </button>
    </div>
  );
}
