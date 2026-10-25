'use client';

import { useTranslations } from 'use-intl';

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
  const t = useTranslations();
  const submissionId = useRef<string | null>(null);
  return (
    <CreateEntityDialog
      title={t('conversations.create')}
      initialName={t('conversations.untitled')}
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
      <button className="text-action" aria-label={t('conversations.create')}>
        <Plus size={15} aria-hidden="true" />
        <span>{t('common.create')}</span>
      </button>
    </CreateEntityDialog>
  );
}
