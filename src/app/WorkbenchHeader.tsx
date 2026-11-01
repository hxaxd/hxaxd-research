'use client';

import './WorkbenchHeader.css';


import { useTranslations } from 'use-intl';

import { clsx } from 'clsx';
import { Layers2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode, type CSSProperties } from 'react';

import { CreateWorkspaceDialog } from '@/app/workspaces/CreateWorkspaceDialog';
import type { Workspace } from '@/app/workspaces/schema';
import { requestJson } from '@/shared/http/request-json';
import { EntitySwitcher } from '@/shared/ui/EntityControls';
import { SettingsDialog } from '@/app/settings/components/SettingsDialog';

export function WorkbenchHeader({
  workspace,
  onRenamed,
  workspaces,
  identityInCenter = false,
  children,
  start,
  end,
  style,
}: {
  workspace: Workspace | null;
  onRenamed?: (workspace: Workspace) => void;
  workspaces: Workspace[];
  identityInCenter?: boolean;
  children?: ReactNode;
  start?: ReactNode;
  end?: ReactNode;
  style?: CSSProperties;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const brand = <span className="brand-mark" title="HX"><Layers2 size={16} aria-hidden="true" /></span>;
  const identity = workspaces.length > 0 ? (
    <EntitySwitcher className="workspace-name" value={workspace?.id ?? ''}
      leading={brand}
      label={t('workspaces.switch')} nameLabel={t('workspaces.name')}
      items={workspaces.map(item => item.id === workspace?.id ? workspace : item)}
      onSelect={id => router.push(`/workspaces/${id}`)}
      createLabel={t('workspaces.create')} onCreate={() => setCreating(true)}
      onSave={async name => {
        onRenamed!(await requestJson<Workspace>(`/api/workspaces/${workspace!.id}`, {
          method: 'PATCH', body: JSON.stringify({ name }),
        }));
      }} />
  ) : <span className="header-identity">{brand}<span className="workspace-name">{t('app.name')}</span></span>;
  return (
    <header className={clsx('app-header', workspace && 'workbench-header')} style={style}>
      {workspace && <div className="header-materials">{!identityInCenter && identity}{start}</div>}
      <div className="header-center">
        {(!workspace || identityInCenter) && identity}
        {children}
      </div>
      <div className="header-actions">
        {end}
        <SettingsDialog />
      </div>
      {creating && <CreateWorkspaceDialog open onOpenChange={setCreating} />}
    </header>
  );
}
