'use client';

import './WorkbenchHeader.css';


import { useTranslations } from 'use-intl';

import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, FolderOpen, Layers2, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { CreateWorkspaceDialog } from '@/app/workspaces/CreateWorkspaceDialog';
import type { Workspace } from '@/app/workspaces/schema';
import { requestJson } from '@/shared/http/request-json';
import { EditableText } from '@/shared/ui/EntityControls';
import { SettingsDialog } from '@/app/settings/components/SettingsDialog';

export function WorkbenchHeader({
  workspace,
  onRenamed,
  workspaces,
}: {
  workspace: Workspace | null;
  onRenamed?: (workspace: Workspace) => void;
  workspaces: Workspace[];
}) {
  const t = useTranslations();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  return (
    <header className="app-header">
      <span className="brand-mark" title="HX">
        <Layers2 size={18} aria-hidden="true" />
      </span>
      <div className="workspace-navigation">
        {workspace ? (
          <EditableText
            className="workspace-name"
            value={workspace.name}
            label={t('workspaces.name')}
            onSave={async (name) => {
              onRenamed!(
                await requestJson<Workspace>(
                  `/api/workspaces/${workspace.id}`,
                  { method: 'PATCH', body: JSON.stringify({ name }) },
                ),
              );
            }}
          />
        ) : (
          <span className="workspace-name">{t('app.name')}</span>
        )}
        {workspaces.length > 0 && <Menu.Root modal={false}>
          <Menu.Trigger
            className="workspace-menu-trigger icon-button"
            aria-label={t('workspaces.switch')}
            title={t('workspaces.switch')}
          >
            <ChevronDown size={15} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content
              className="workspace-menu menu-surface"
              align="end"
              sideOffset={10}
              collisionPadding={12}
            >
              <Menu.Label className="menu-label">{t('workspaces.title')}</Menu.Label>
              <div className="workspace-menu-list">
                {workspaces.map((item) => (
                  <Menu.Item
                    className="workspace-menu-item menu-item"
                    key={item.id}
                    onSelect={() => router.push(`/workspaces/${item.id}`)}
                  >
                    <FolderOpen size={15} aria-hidden="true" />
                    <span>
                      {item.id === workspace?.id ? workspace.name : item.name}
                    </span>
                    {item.id === workspace?.id && (
                      <Check size={14} aria-hidden="true" />
                    )}
                  </Menu.Item>
                ))}
              </div>
              <Menu.Separator className="menu-separator" />
              <Menu.Item
                className="workspace-menu-item menu-item create-workspace-item"
                onSelect={() => setCreating(true)}
              >
                <Plus size={16} aria-hidden="true" />
                <span>{t('workspaces.create')}</span>
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>}
      </div>
      <div className="header-spacer" />
      <SettingsDialog />
      {creating && <CreateWorkspaceDialog open onOpenChange={setCreating} />}
    </header>
  );
}
