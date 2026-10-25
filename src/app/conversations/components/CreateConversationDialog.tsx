'use client';

import { Plus } from 'lucide-react';
import { useRef } from 'react';

import { requestJson } from '@/shared/http/request-json';
import { CreateEntityDialog } from '@/shared/ui/EntityControls';

import type { Conversation } from '../schema';

export function CreateConversationDialog({
  workspaceId,
  onCreated,
}: {
  workspaceId: string;
  onCreated: (conversation: Conversation) => void;
}) {
  const submissionId = useRef<string | null>(null);
  return (
    <CreateEntityDialog
      title="新建对话"
      label="这段对话可以讨论工作区中的多篇论文。"
      initialName="新对话"
      onSubmit={async (name) => {
        const id = submissionId.current ??= crypto.randomUUID();
        onCreated(
          await requestJson<Conversation>(`/api/workspaces/${workspaceId}/conversations`, {
            method: 'POST',
            body: JSON.stringify({ id, name }),
          }),
        );
        submissionId.current = null;
      }}
    >
      <button className="text-action" aria-label="新建对话">
        <Plus size={15} aria-hidden="true" />
        <span>新建</span>
      </button>
    </CreateEntityDialog>
  );
}
