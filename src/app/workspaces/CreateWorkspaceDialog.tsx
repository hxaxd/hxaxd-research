'use client';

import { useTranslations } from 'use-intl';

import { Plus } from 'lucide-react';
import { useRef } from 'react';
import { useRouter } from 'next/navigation';

import { requestJson } from '@/shared/http/request-json';
import { CreateEntityDialog } from '@/shared/ui/EntityControls';

import type { Workspace } from './schema';

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const submissionId = useRef<string | null>(null);
  return (
    <CreateEntityDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('workspaces.create')}
      onSubmit={async (name) => {
        const id = submissionId.current ??= crypto.randomUUID();
        const workspace = await requestJson<Workspace>('/api/workspaces', {
          method: 'POST',
          body: JSON.stringify({ id, name }),
        });
        submissionId.current = null;
        router.push(`/workspaces/${workspace.id}`);
        router.refresh();
      }}
    >
      {open === undefined && (
        <button
          className="button primary"
          aria-label={t('workspaces.create')}
          title={t('workspaces.create')}
        >
          <Plus size={18} />
          {t('workspaces.create')}
        </button>
      )}
    </CreateEntityDialog>
  );
}
