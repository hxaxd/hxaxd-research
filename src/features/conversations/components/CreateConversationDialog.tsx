'use client';
import { Plus } from 'lucide-react';
import { NameDialog } from '@/shared/ui/NameDialog';
import { requestJson } from '@/shared/http/request-json';
import type { Conversation } from '../conversation-schema';
export function CreateConversationDialog({ workspaceId, onCreated }: { workspaceId: string; onCreated: (conversation: Conversation) => void }) {
  return <NameDialog title="新建对话" label="这段对话可以讨论工作区中的多篇论文。" initialName="新对话" onSubmit={async (name, id) => onCreated(await requestJson<Conversation>(`/api/workspaces/${workspaceId}/conversations`, { method: 'POST', body: JSON.stringify({ id, name }) }))}><button className="icon-button" aria-label="新建对话"><Plus size={17} /></button></NameDialog>;
}
