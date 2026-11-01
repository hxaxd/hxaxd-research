'use client';

import { useTranslations } from 'use-intl';

import { useRef } from 'react';

import { requestJson } from '@/shared/http/request-json';
import { CreateEntityDialog } from '@/shared/ui/EntityControls';

import type { Conversation } from '../schema';

export function CreateConversationDialog({
  workspaceId,
  onCreated,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (conversation: Conversation) => void;
}) {
  const t = useTranslations();
  const submissionId = useRef<string | null>(null);
  return (
    <CreateEntityDialog
      title={t('conversations.create')}
      open={open}
      onOpenChange={onOpenChange}
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
    />
  );
}
