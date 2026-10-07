import { notFound } from 'next/navigation';
import { getAppRuntime } from '@/server/app-runtime';
import { getWorkspace, listWorkspaces } from '@/features/workspaces/server/workspace-store';
import { listPapers } from '@/features/papers/server/paper-store';
import { listConversations } from '@/features/conversations/server/conversation-store';
import { idSchema } from '@/features/workspaces/workspace-schema';
import { ApiError } from '@/shared/http/api-error';
import { ResearchWorkbench } from '@/features/workspaces/components/ResearchWorkbench';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export default async function WorkspacePage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId } = await params;
  if (!idSchema.safeParse(workspaceId).success) notFound();
  const app = getAppRuntime(); await app.ready;
  let workspace;
  try { workspace = getWorkspace(app.db, workspaceId); } catch (error) { if (error instanceof ApiError && error.status === 404) notFound(); throw error; }
  const papers = listPapers(app.db, workspaceId), conversations = listConversations(app.db, workspaceId), query = await searchParams;
  return <ResearchWorkbench key={workspaceId} initialWorkspace={workspace} workspaces={listWorkspaces(app.db)} initialPapers={papers} initialConversations={conversations} initialPaper={typeof query.paper === 'string' && papers.some(paper => paper.id === query.paper) ? query.paper : null} initialFile={typeof query.file === 'string' ? query.file : null} initialConversation={typeof query.conversation === 'string' && conversations.some(conversation => conversation.id === query.conversation) ? query.conversation : null} />;
}
