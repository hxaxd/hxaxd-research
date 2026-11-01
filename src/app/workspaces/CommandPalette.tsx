'use client';

import './CommandPalette.css';

import { Command } from 'cmdk';
import { BookOpen, FileText, Folder, Layers2, MessageSquarePlus, PanelLeft, PanelRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';

import { useFileList } from '@/app/files/components/FileTree';
import type { Workspace } from './schema';

type Action = { id: string; label: string; icon: ReactNode; run: () => void };

/**
 * ⌘K / Ctrl+K palette. With an empty query it lists papers; typing searches
 * file and paper names through the files API, plus actions and workspaces.
 */
export function CommandPalette({ workspaceId, workspaces, revision, onOpenFile, actions }: {
  workspaceId: string;
  workspaces: Workspace[];
  revision: number;
  onOpenFile: (path: string) => void;
  actions: { toggleMaterials: () => void; toggleConversation: () => void; newConversation: () => void };
}) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen(value => !value);
      }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 150);
    return () => clearTimeout(timer);
  }, [query]);
  const params: Record<string, string> = search ? { q: search } : { view: 'papers' };
  const { files } = useFileList(workspaceId, params, revision, open);
  const needle = query.trim().toLowerCase();
  const commands: Action[] = [
    { id: 'materials', label: t('commands.toggleMaterials'), icon: <PanelLeft size={15} />, run: actions.toggleMaterials },
    { id: 'conversation', label: t('commands.toggleConversation'), icon: <PanelRight size={15} />, run: actions.toggleConversation },
    { id: 'new-conversation', label: t('commands.newConversation'), icon: <MessageSquarePlus size={15} />, run: actions.newConversation },
  ].filter(action => !needle || action.label.toLowerCase().includes(needle));
  const otherWorkspaces = workspaces.filter(item => item.id !== workspaceId
    && (!needle || item.name.toLowerCase().includes(needle)));
  const papers = files?.filter(file => file.marker?.type === 'paper') ?? [];
  const others = files?.filter(file => file.marker?.type !== 'paper') ?? [];
  const close = (run: () => void) => () => { setOpen(false); setQuery(''); run(); };

  return <Command.Dialog open={open} onOpenChange={setOpen} shouldFilter={false} label={t('commands.open')}
    overlayClassName="dialog-overlay" contentClassName="command-palette">
    <Command.Input value={query} onValueChange={setQuery} placeholder={t('commands.placeholder')} className="command-input" />
    <Command.List className="command-list">
      <Command.Empty className="command-empty">{files === null ? t('common.loading') : t('commands.empty')}</Command.Empty>
      {papers.length > 0 && <Command.Group heading={t('commands.papers')}>
        {papers.map(file => <Command.Item key={file.path} value={`paper:${file.path}`}
          onSelect={close(() => onOpenFile(file.marker?.main ?? file.path))}>
          <BookOpen size={15} /><span>{file.marker?.title || file.name}</span><small>{file.path}</small>
        </Command.Item>)}
      </Command.Group>}
      {others.length > 0 && <Command.Group heading={t('commands.files')}>
        {others.slice(0, 50).map(file => <Command.Item key={file.path} value={`file:${file.path}`}
          disabled={file.kind === 'directory'} onSelect={close(() => onOpenFile(file.path))}>
          {file.kind === 'directory' ? <Folder size={15} /> : <FileText size={15} />}<span>{file.name}</span><small>{file.path}</small>
        </Command.Item>)}
      </Command.Group>}
      {commands.length > 0 && <Command.Group heading={t('commands.actions')}>
        {commands.map(action => <Command.Item key={action.id} value={`action:${action.id}`} onSelect={close(action.run)}>
          {action.icon}<span>{action.label}</span>
        </Command.Item>)}
      </Command.Group>}
      {otherWorkspaces.length > 0 && <Command.Group heading={t('commands.workspaces')}>
        {otherWorkspaces.map(item => <Command.Item key={item.id} value={`workspace:${item.id}`}
          onSelect={close(() => router.push(`/workspaces/${item.id}`))}>
          <Layers2 size={15} /><span>{item.name}</span>
        </Command.Item>)}
      </Command.Group>}
    </Command.List>
  </Command.Dialog>;
}
