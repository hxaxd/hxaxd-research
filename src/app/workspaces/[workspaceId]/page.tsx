import { notFound } from 'next/navigation';

import { listConversations } from '@/app/conversations/server/conversations';
import {
  getWorkspace,
  listWorkspaces,
} from '@/app/workspaces/workspaces';
import { getAppRuntime } from '@/app/runtime';
import { isApiError } from '@/shared/http/api-error';
import { idSchema } from '@/shared/schema';

import { Workbench } from './Workbench';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  if (!idSchema.safeParse(workspaceId).success) notFound();
  const app = getAppRuntime();

  let workspace;
  try {
    workspace = getWorkspace(app.config.workspaceDir, workspaceId);
  } catch (error) {
    if (isApiError(error) && error.status === 404) notFound();
    throw error;
  }
  const conversations = await listConversations(
    app.config.workspaceDir,
    workspaceId,
  );
  const query = await searchParams;
  return (
    <Workbench
      key={workspaceId}
      initialWorkspace={workspace}
      workspaces={listWorkspaces(app.config.workspaceDir)}
      initialConversations={conversations}
      initialFile={typeof query.file === 'string' ? query.file : null}
      initialConversation={
        typeof query.conversation === 'string' &&
        conversations.some(
          (conversation) => conversation.id === query.conversation,
        )
          ? query.conversation
          : null
      }
    />
  );
}
