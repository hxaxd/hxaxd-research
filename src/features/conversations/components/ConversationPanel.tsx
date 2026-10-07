'use client';
import { Pencil } from 'lucide-react';
import { useConversationStream } from '../hooks/use-conversation-stream';
import type { Conversation, ConfiguredModel } from '../conversation-schema';
import type { MaterialReference } from '@/features/files/file-schema';
import { NameDialog } from '@/shared/ui/NameDialog';
import { requestJson } from '@/shared/http/request-json';
import { ConversationMessages } from './ConversationMessages';
import { ConversationComposer } from './ConversationComposer';
export function ConversationPanel({ workspaceId, conversation, models, model, onModelChange, materials, onRemove, onSent, onRenamed }: { workspaceId: string; conversation: Conversation; models: ConfiguredModel[]; model: string; onModelChange: (id: string) => void; materials: MaterialReference[]; onRemove: (path: string) => void; onSent: () => void; onRenamed: (conversation: Conversation) => void }) {
  const url = `/api/workspaces/${workspaceId}/conversations/${conversation.id}`;
  const { snapshot, connected, error } = useConversationStream(url);
  const running = snapshot?.run?.status === 'accepted' || snapshot?.run?.status === 'running';
  return <>
    <div className="model-toolbar"><select aria-label="选择模型" value={model} onChange={event => onModelChange(event.target.value)} disabled={running || !models.length}><option value="">选择模型</option>{models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.provider}</option>)}</select><NameDialog title="重命名对话" label="为这段讨论起一个容易辨认的名称。" initialName={conversation.name} onSubmit={async name => onRenamed(await requestJson<Conversation>(url, { method: 'PATCH', body: JSON.stringify({ name }) }))}><button className="icon-button" aria-label="重命名对话"><Pencil size={14} /></button></NameDialog></div>
    {error && <p role="alert" className="error-message">{error}</p>}
    <ConversationMessages snapshot={snapshot} />
    <ConversationComposer url={url} model={model} run={snapshot?.run ?? null} materials={materials} onRemove={onRemove} onSent={onSent} connected={connected} />
  </>;
}
