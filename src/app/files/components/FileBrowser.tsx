'use client';

import './FileBrowser.css';

import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';

import { FileRow, FileTree, FileTreeFolder, useFileList } from './FileTree';

/**
 * One tree for the whole workspace. The workspace root is not a node; its
 * children are the first level. "Papers only" and search flatten the tree into
 * matching entries, and paper folders stay expandable in every mode.
 */
export function FileBrowser({ workspaceId, papersOnly, revision, activePath, onOpenFile, onChanged }: {
  workspaceId: string;
  papersOnly: boolean;
  revision: number;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onChanged: () => void;
}) {
  const t = useTranslations();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const flat = papersOnly || !!search;
  const params: Record<string, string> = papersOnly ? { view: 'papers' } : {};
  if (search) params.q = search;
  const { files, error } = useFileList(workspaceId, params, revision, flat);
  const tree = { workspaceId, revision, activePath, onOpenFile, onChanged };
  return (
    <section className="file-browser">
      <label className="file-search">
        <Search size={14} aria-hidden="true" />
        <input type="search" value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); } }}
          aria-label={t('files.search')} placeholder={t('files.search')} maxLength={200} />
        {query && <button className="icon-button" aria-label={t('files.clearSearch')} title={t('files.clearSearch')}
          onClick={() => setQuery('')}><X size={13} /></button>}
      </label>
      {!flat && <FileTree {...tree} directory="" />}
      {flat && <>
        {error && <p role="alert" className="error-message">{error}</p>}
        {!error && files === null && <p className="empty-small" role="status">{t('common.loading')}</p>}
        {!error && files?.length === 0 && <p className="empty-small">{t(search ? 'files.noMatches' : 'files.noPapers')}</p>}
        <div className="file-tree file-tree-root">
          {files?.map(file => file.kind === 'directory'
            ? <FileTreeFolder key={file.path} file={file} showPath {...tree} />
            : <FileRow key={file.path} file={file} showPath activePath={activePath} onOpenFile={onOpenFile} />)}
        </div>
      </>}
    </section>
  );
}
