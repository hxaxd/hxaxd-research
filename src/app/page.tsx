import { BookOpen } from 'lucide-react';
import '@/app/workspaces/workbench.css';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { localeCookie, resolveLocale, translator } from '@/shared/i18n/config.mjs';

import { CreateWorkspaceDialog } from '@/app/workspaces/CreateWorkspaceDialog';
import { listWorkspaces } from '@/app/workspaces/workspaces';
import { getAppRuntime } from '@/app/runtime';

import { WorkbenchHeader } from './WorkbenchHeader';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Home() {
  const t = translator(resolveLocale((await cookies()).get(localeCookie)?.value));
  const workspaces = listWorkspaces(getAppRuntime().config.workspaceDir);
  if (workspaces.length) {
    const last = (await cookies()).get('research-last-workspace')?.value;
    const saved = last ?? '';
    const id = saved.split('?')[0].split('/')[2];
    if (
      saved.startsWith('/workspaces/') &&
      workspaces.some((workspace) => workspace.id === id)
    )
      redirect(saved);
    redirect(`/workspaces/${workspaces[0].id}`);
  }
  return (
    <div className="app-shell">
      <WorkbenchHeader workspace={null} workspaces={[]} />
      <main className="first-workspace">
        <div className="reader-empty">
          <div className="reader-mark">
            <BookOpen size={36} strokeWidth={1.4} aria-hidden="true" />
          </div>
          <h1>{t('workspaces.createTopic')}</h1>
          <CreateWorkspaceDialog />
        </div>
      </main>
    </div>
  );
}
