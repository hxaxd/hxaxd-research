'use client';

import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, FolderOpen, Layers2, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { CreateWorkspaceDialog } from '@/features/workspaces/components/CreateWorkspaceDialog';
import type { Workspace } from '@/features/workspaces/schema';
import { requestJson } from '@/shared/http/request-json';
import { EditableText } from '@/shared/ui/EntityControls';
import { SettingsDialog } from '@/features/settings/components/SettingsDialog';

export function WorkbenchHeader({
  workspace,
  onRenamed,
  workspaces,
}: {
  workspace: Workspace | null;
  onRenamed?: (workspace: Workspace) => void;
  workspaces: Workspace[];
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  return (
    <header className="app-header">
      <span className="brand-mark" title="科研工作台">
        <Layers2 size={18} aria-hidden="true" />
      </span>
      <div className="workspace-navigation">
        {workspace ? (
          <EditableText
            className="workspace-name"
            value={workspace.name}
            label="工作区名称"
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
          <span className="workspace-name">科研工作台</span>
        )}
        <Menu.Root modal={false}>
          <Menu.Trigger
            className="workspace-menu-trigger icon-button"
            aria-label="切换工作区"
            title="切换工作区"
          >
            <ChevronDown size={15} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content
              className="workspace-menu"
              align="end"
              sideOffset={10}
              collisionPadding={12}
            >
              <Menu.Label className="menu-label">工作区</Menu.Label>
              <div className="workspace-menu-list">
                {workspaces.map((item) => (
                  <Menu.Item
                    className="workspace-menu-item"
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
                className="workspace-menu-item create-workspace-item"
                onSelect={() => setCreating(true)}
              >
                <Plus size={16} aria-hidden="true" />
                <span>新建工作区</span>
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      </div>
      <div className="header-spacer" />
      <SettingsDialog />
      {creating && <CreateWorkspaceDialog open onOpenChange={setCreating} />}
    </header>
  );
}
