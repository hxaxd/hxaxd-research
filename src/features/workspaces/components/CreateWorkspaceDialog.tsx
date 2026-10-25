'use client';

import { Plus } from 'lucide-react';
import { useRef } from 'react';
import { useRouter } from 'next/navigation';

import { requestJson } from '@/shared/http/request-json';
import { CreateEntityDialog } from '@/shared/ui/EntityControls';

import type { Workspace } from '../schema';

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const router = useRouter();
  const submissionId = useRef<string | null>(null);
  return (
    <CreateEntityDialog
      open={open}
      onOpenChange={onOpenChange}
      title="新建工作区"
      label="为一个研究主题建立独立的材料与对话空间。"
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
          aria-label="新建工作区"
          title="新建工作区"
        >
          <Plus size={18} />
          新建工作区
        </button>
      )}
    </CreateEntityDialog>
  );
}
