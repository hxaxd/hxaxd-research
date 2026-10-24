import { BookOpen } from 'lucide-react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { CreateWorkspaceDialog } from '@/features/workspaces/components/CreateWorkspaceDialog';
import { listWorkspaces } from '@/features/workspaces/server/workspaces';
import { getAppRuntime } from '@/server/runtime';

import { WorkbenchHeader } from './workspaces/[workspaceId]/WorkbenchHeader';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Home() {
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
          <h1>从一个研究主题开始</h1>
          <p>建立工作区，放入材料，开始阅读与讨论。</p>
          <CreateWorkspaceDialog />
        </div>
      </main>
    </div>
  );
}
