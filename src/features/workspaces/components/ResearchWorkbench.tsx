'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BookOpen, Layers2, MessageSquare, PanelLeft, Pencil } from 'lucide-react';
import type { Workspace } from '../workspace-schema';
import type { Paper } from '@/features/papers/paper-schema';
import type { Conversation, ConfiguredModel } from '@/features/conversations/conversation-schema';
import type { MaterialReference } from '@/features/files/file-schema';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';
import { CreatePaperDialog } from '@/features/papers/components/CreatePaperDialog';
import { PaperList } from '@/features/papers/components/PaperList';
import { WorkspaceFileTree } from '@/features/files/components/WorkspaceFileTree';
import { ResourcePreview } from '@/features/files/components/ResourcePreview';
import { CreateConversationDialog } from '@/features/conversations/components/CreateConversationDialog';
import { ConversationPanel } from '@/features/conversations/components/ConversationPanel';
import { NameDialog } from '@/shared/ui/NameDialog';
import { requestJson } from '@/shared/http/request-json';
export function ResearchWorkbench({ initialWorkspace, workspaces, initialPapers, initialConversations, initialPaper, initialFile, initialConversation }: { initialWorkspace: Workspace; workspaces: Workspace[]; initialPapers: Paper[]; initialConversations: Conversation[]; initialPaper: string | null; initialFile: string | null; initialConversation: string | null }) {
  const router = useRouter();
  const [workspace, setWorkspace] = useState(initialWorkspace), [papers, setPapers] = useState(initialPapers), [conversations, setConversations] = useState(initialConversations);
  const [paperId, setPaperId] = useState(initialPaper), [file, setFile] = useState(initialFile), [conversationId, setConversationId] = useState(initialConversation ?? initialConversations[0]?.id ?? null);
  const [models, setModels] = useState<ConfiguredModel[]>([]), [model, setModel] = useState(''), [modelError, setModelError] = useState(''), [mobilePanel, setMobilePanel] = useState('materials');
  const [drafts, setDrafts] = useState<Record<string, MaterialReference[]>>({});
  const draftKey = conversationId ?? '_new';
  const materials = drafts[draftKey] ?? [];
  useEffect(() => {
    const controller = new AbortController();
    void requestJson<ConfiguredModel[]>('/api/models', { signal: controller.signal }).then(models => { setModels(models); setModel(models[0]?.id ?? ''); }).catch(error => { if (!controller.signal.aborted) setModelError(error.message); });
    return () => controller.abort();
  }, []);
  function query(key: string, value: string | null) { const url = new URL(window.location.href); if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); window.history.replaceState(null, '', url); }
  function selectPaper(id: string | null) { setPaperId(id); query('paper', id); }
  function selectConversation(id: string) { setConversationId(id); query('conversation', id); }
  function reference(path: string) { setDrafts(current => { const items = current[draftKey] ?? []; return items.some(item => item.path === path) ? current : { ...current, [draftKey]: [...items, { path }] }; }); setMobilePanel('conversation'); }
  const currentConversation = conversations.find(conversation => conversation.id === conversationId);
  return <div className="app-shell">
    <header className="app-header"><Link href="/" className="brand"><Layers2 size={22} /><span>科研工作台</span></Link><span className="header-divider" /><select className="workspace-switcher" aria-label="切换工作区" value={workspace.id} onChange={event => router.push(`/workspaces/${event.target.value}`)}>{workspaces.map(item => <option key={item.id} value={item.id}>{item.id === workspace.id ? workspace.name : item.name}</option>)}</select>
      <NameDialog title="重命名工作区" label="修改名称不会改变资料和对话。" initialName={workspace.name} onSubmit={async name => setWorkspace(await requestJson<Workspace>(`/api/workspaces/${workspace.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }))}><button className="icon-button" aria-label="重命名工作区"><Pencil size={14} /></button></NameDialog><div className="header-spacer" /><span className="local-indicator"><i />本地工作区</span><CreateWorkspaceDialog compact /></header>
    <nav className="mobile-tabs" aria-label="工作台面板">{[['materials', '材料', PanelLeft], ['reader', '阅读', BookOpen], ['conversation', '对话', MessageSquare]].map(([id, label, Icon]) => { const Glyph = Icon as typeof PanelLeft; return <button key={id as string} className={mobilePanel === id ? 'active' : ''} onClick={() => setMobilePanel(id as string)}><Glyph size={16} />{label as string}</button>; })}</nav>
    <main className={`workbench show-${mobilePanel}`}>
      <aside className="materials-panel"><div className="panel-heading"><span>论文 <small>{papers.length}</small></span><CreatePaperDialog workspaceId={workspace.id} onCreated={paper => { setPapers(current => [...current, paper]); selectPaper(paper.id); }} /></div><PaperList papers={papers} workspaceId={workspace.id} activeId={paperId} onSelect={selectPaper} onRenamed={paper => setPapers(current => current.map(item => item.id === paper.id ? paper : item))} />
        <WorkspaceFileTree key={paperId ?? 'root'} workspaceId={workspace.id} rootPath={paperId ? `papers/${paperId}` : ''} onOpenFile={path => { setFile(path); query('file', path); setMobilePanel('reader'); }} onReference={reference} />
        <div className="sidebar-foot">文件来自真实目录<br />外部添加后刷新即可查看</div>
      </aside>
      <ResourcePreview workspaceId={workspace.id} path={file} onReference={reference} />
      <section className="conversation-panel"><div className="panel-heading"><span>对话</span><CreateConversationDialog workspaceId={workspace.id} onCreated={conversation => { setConversations(current => [...current, conversation]); if (!conversationId) setDrafts(current => ({ ...current, [conversation.id]: current._new ?? [] })); selectConversation(conversation.id); }} /></div>
        {conversations.length > 0 && <div className="conversation-tabs" role="tablist" aria-label="对话列表">{conversations.map(conversation => <button role="tab" aria-selected={conversation.id === conversationId} key={conversation.id} className={conversation.id === conversationId ? 'active' : ''} onClick={() => selectConversation(conversation.id)}>{conversation.name}</button>)}</div>}
        {modelError && <p className="error-message" role="alert">{modelError}</p>}
        {currentConversation ? <ConversationPanel key={currentConversation.id} workspaceId={workspace.id} conversation={currentConversation} models={models} model={model} onModelChange={setModel} materials={materials} onRemove={path => setDrafts(current => ({ ...current, [draftKey]: (current[draftKey] ?? []).filter(item => item.path !== path) }))} onSent={() => { setDrafts(current => ({ ...current, [draftKey]: [] }));  }} onRenamed={conversation => setConversations(current => current.map(item => item.id === conversation.id ? conversation : item))} /> : <div className="chat-empty"><MessageSquare size={27} strokeWidth={1.3} /><h3>给思考留一个位置</h3><p>从右上角新建对话，<br />与助手讨论当前工作区的材料。</p>{materials.length > 0 && <p>已准备 {materials.length} 份材料引用</p>}</div>}
      </section>
    </main>
  </div>;
}
