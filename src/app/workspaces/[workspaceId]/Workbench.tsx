'use client';

import '../workbench.css';
import '@/app/conversations/conversations.css';


import { clsx } from 'clsx';
import { useTranslations } from 'use-intl';

import {
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';

import { ConversationPanel } from '@/app/conversations/components/ConversationPanel';
import { CreateConversationDialog } from '@/app/conversations/components/CreateConversationDialog';
import type { Conversation } from '@/app/conversations/schema';
import { FilePreview, FilePreviewHeader } from '@/app/files/components/FilePreview';
import { FileBrowser } from '@/app/files/components/FileBrowser';
import { FileBrowserToolbar } from '@/app/files/components/FileBrowserToolbar';
import { ReaderToolbarProvider } from '@/app/files/components/ReaderToolbar';
import {
  fileChangeSchema,
  maxImageClips,
  maxTextQuotes,
  readerRequestSchema,
  type ReadingContext,
  type DocumentRequest,
  type ReaderRequest,
  type ViewMode,
  type ImageClip,
  type TextQuote,
} from '@/app/files/schema';
import { ModelSettingsButton } from '@/app/models/components/ModelSettingsButton';
import { modelsChangedEvent } from '@/app/models/components/model-events';
import type { ConfiguredModel, ModelCatalog } from '@/app/models/schema';
import type { Workspace } from '@/app/workspaces/schema';
import { requestJson } from '@/shared/http/request-json';
import { EntitySwitcher } from '@/shared/ui/EntityControls';

import { WorkbenchHeader } from '@/app/WorkbenchHeader';
import { CommandPalette } from '@/app/workspaces/CommandPalette';
import { useWorkbenchLayout } from './use-workbench-layout';

type WorkbenchProps = {
  initialWorkspace: Workspace;
  workspaces: Workspace[];
  initialConversations: Conversation[];
  initialFile: string | null;
  initialConversation: string | null;
};

function updateQuery(key: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(key, value);
  else url.searchParams.delete(key);
  window.history.replaceState(null, '', url);
  rememberWorkspace();
}

function rememberWorkspace() {
  document.cookie = `research-last-workspace=${encodeURIComponent(window.location.pathname + window.location.search)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function Workbench({
  initialWorkspace,
  workspaces,
  initialConversations,
  initialFile,
  initialConversation,
}: WorkbenchProps) {
  const t = useTranslations();
  const workspaceId = initialWorkspace.id;
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [conversations, setConversations] = useState(initialConversations);
  const [file, setFile] = useState(initialFile);
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [readerRequest, setReaderRequest] = useState<DocumentRequest | null>(null);
  const [filesRevision, setFilesRevision] = useState(0);
  const [papersOnly, setPapersOnly] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [readerTools, setReaderTools] = useState<HTMLElement | null>(null);
  const [fileRevisions, setFileRevisions] = useState<Record<string, number>>(
    {},
  );
  const [fileError, setFileError] = useState('');
  const filesChanged = useCallback((paths: string[]) => {
    setFilesRevision((value) => value + 1);
    setFileRevisions((current) => {
      const next = { ...current };
      for (const path of paths) next[path] = (current[path] ?? 0) + 1;
      return next;
    });
  }, []);
  const [conversationId, setConversationId] = useState(
    initialConversation ?? initialConversations[0]?.id ?? null,
  );
  const [models, setModels] = useState<ConfiguredModel[]>([]);
  const [model, setModel] = useState('');
  const [clips, setClips] = useState<Record<string, ImageClip[]>>({});
  const [quotes, setQuotes] = useState<Record<string, TextQuote[]>>({});
  const [modelError, setModelError] = useState('');
  const [modelIssues, setModelIssues] = useState<ModelCatalog['issues']>([]);
  const workbenchRef = useRef<HTMLElement>(null);
  const layout = useWorkbenchLayout(workbenchRef);
  const materialsOpen = layout.panels.materials.open;
  const conversationOpen = layout.panels.conversation.open;
  const [pdfPosition, setPdfPosition] = useState<{ path: string; page: number } | null>(null);
  const reading: ReadingContext | null = file
    ? {
        path: file,
        ...(/\.(md|markdown|html?)$/i.test(file) ? { mode: viewMode } : {}),
        ...(file.toLowerCase().endsWith('.pdf')
          ? { page: pdfPosition?.path === file ? pdfPosition.page : 1 }
          : {}),
      }
    : null;
  const currentConversation = conversations.find(
    (item) => item.id === conversationId,
  );
  const lastOpened = useRef('');
  const openDocument = useCallback((target: ReadingContext) => {
    setFile(target.path);
    setViewMode(target.mode ?? 'preview');
    setPdfPosition({ path: target.path, page: target.page ?? 1 });
    updateQuery('file', target.path);
    // Reopening the same document at the same place keeps the open viewer instead of reloading it.
    const key = `${target.path}|${target.mode ?? ''}|${target.page ?? ''}`;
    if (lastOpened.current === key) return;
    lastOpened.current = key;
    setReaderRequest({ ...target, id: crypto.randomUUID() });
  }, []);

  const displayDocument = useEffectEvent((request: ReaderRequest) => {
    if (request.conversationId !== conversationId) return;
    openDocument(request);
  });

  useEffect(() => rememberWorkspace(), [workspaceId]);

  useEffect(() => {
    const stream = new EventSource(
      `/api/workspaces/${workspaceId}/files/events`,
    );
    const controller = new AbortController();
    stream.addEventListener('reader', (event) => {
      try {
        displayDocument(readerRequestSchema.parse(JSON.parse(event.data)));
      } catch (error) {
        setFileError((error as Error).message);
      }
    });
    stream.onmessage = (event) => {
      try {
        const { paths } = fileChangeSchema.parse(JSON.parse(event.data));
        filesChanged(paths);
        setFileError('');
        if (paths.includes('workspace.json') || paths.includes('')) {
          void requestJson<Workspace>(`/api/workspaces/${workspaceId}`, { signal: controller.signal })
            .then(setWorkspace)
            .catch((error) => {
              if (!controller.signal.aborted) setFileError(error.message);
            });
        }
      } catch (error) {
        setFileError((error as Error).message);
      }
    };
    stream.onerror = () =>
      setFileError(t('files.reconnecting'));
    stream.onopen = () => {
      filesChanged(['']);
      setFileError('');
    };
    return () => {
      controller.abort();
      stream.close();
    };
  }, [workspaceId, filesChanged, t]);

  const refreshModels = useCallback((signal?: AbortSignal) =>
    requestJson<ModelCatalog>('/api/models', { signal }).then(next => {
      const saved = localStorage.getItem('research-model');
      setModels(next.models);
      setModelIssues(next.issues);
      setModel(current => next.models.find(model => model.id === current)?.id
        ?? next.models.find(model => model.id === saved)?.id ?? next.models[0]?.id ?? '');
      setModelError('');
    }).catch(error => {
      if (!signal?.aborted) {
        setModels([]);
        setModel('');
        setModelError((error as Error).message);
      }
    }), []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshModels(controller.signal);
    return () => controller.abort();
  }, [refreshModels]);

  useEffect(() => {
    const changed = () => void refreshModels();
    window.addEventListener(modelsChangedEvent, changed);
    return () => window.removeEventListener(modelsChangedEvent, changed);
  }, [refreshModels]);

  function selectModel(id: string) {
    setModel(id);
    localStorage.setItem('research-model', id);
  }

  function selectConversation(id: string) {
    setConversationId(id);
    setFilesRevision((value) => value + 1);
    updateQuery('conversation', id);
  }

  function openFile(path: string) {
    openDocument({ path });
  }

  function createdConversation(conversation: Conversation) {
    setConversations((current) => [...current, conversation]);
    selectConversation(conversation.id);
  }

  async function referenceConversation() {
    if (conversationId) return conversationId;
    const conversation = await requestJson<Conversation>(`/api/workspaces/${workspaceId}/conversations`, {
      method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), name: t('conversations.materialQuestion') }),
    });
    createdConversation(conversation);
    return conversation.id;
  }

  return (
    <div className="app-shell workspace-shell" style={layout.style} data-materials-open={materialsOpen} data-conversation-open={conversationOpen}>
      <WorkbenchHeader
        style={layout.columns.header}
        workspace={workspace}
        onRenamed={setWorkspace}
        workspaces={workspaces}
        identityInCenter={!materialsOpen}
        start={<>
          <button className="icon-button" aria-label={t(materialsOpen ? 'workspaces.collapseMaterials' : 'workspaces.expandMaterials')}
          title={t(materialsOpen ? 'workspaces.collapseMaterials' : 'workspaces.expandMaterials')}
          aria-expanded={materialsOpen} aria-controls="materials-panel"
          onClick={() => layout.setOpen('materials', !materialsOpen)}>
          {materialsOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button></>}
        end={conversationOpen ? (
          <div className="conversation-heading">
            <button
              className="icon-button"
              aria-label={t('workspaces.collapseConversation')}
              title={t('workspaces.collapseConversation')}
              aria-expanded={conversationOpen}
              aria-controls="conversation-panel"
              onClick={() => layout.setOpen('conversation', false)}
            >
              <PanelRightClose size={16} />
            </button>
            <EntitySwitcher key={conversationId} className="conversation-name" value={conversationId ?? ''}
              label={t('conversations.switch')} nameLabel={t('conversations.name')}
              items={conversations} onSelect={selectConversation}
              createLabel={t('conversations.create')} onCreate={() => setCreatingConversation(true)}
              onSave={async name => {
                const renamed = await requestJson<Conversation>(
                  `/api/workspaces/${workspaceId}/conversations/${currentConversation!.id}`,
                  { method: 'PATCH', body: JSON.stringify({ name }) },
                );
                setConversations(current => current.map(item => item.id === renamed.id ? renamed : item));
              }} />
          </div>
        ) : (
          <button className="icon-button" aria-label={t('workspaces.expandConversation')}
            title={t('workspaces.expandConversation')} aria-expanded={false} aria-controls="conversation-panel"
            onClick={() => layout.setOpen('conversation', true)}>
            <PanelRightOpen size={18} />
          </button>
        )}
      >
        <FilePreviewHeader workspaceId={workspaceId} path={file} mode={viewMode} onModeChange={setViewMode}
          onReload={() => setFileRevisions(current => ({ ...current, [file!]: (current[file!] ?? 0) + 1 }))}
          toolbarRef={setReaderTools} />
      </WorkbenchHeader>
      <CommandPalette workspaceId={workspaceId} workspaces={workspaces} revision={filesRevision} onOpenFile={openFile}
        actions={{
          toggleMaterials: () => layout.setOpen('materials', !materialsOpen),
          toggleConversation: () => layout.setOpen('conversation', !conversationOpen),
          newConversation: () => setCreatingConversation(true),
        }} />
      {creatingConversation && <CreateConversationDialog workspaceId={workspaceId} onCreated={createdConversation}
        open onOpenChange={setCreatingConversation} />}
      <main
        ref={workbenchRef}
        style={layout.columns.main}
        className={clsx('workbench', layout.dragging && 'is-resizing')}
      >
        <aside
          className={clsx('materials-panel', layout.closing === 'materials' && 'collapse-pending')}
          id="materials-panel"
          data-collapse-label={t('workspaces.collapseMaterials')}
          aria-label={t('files.materials')}
          data-open={materialsOpen}
        >
          <div className="panel-content" inert={!materialsOpen} aria-hidden={!materialsOpen}>
            {fileError && (
              <p className="error-message" role="alert">
                {fileError}
              </p>
            )}
            <FileBrowserToolbar workspaceId={workspaceId} papersOnly={papersOnly} onPapersOnlyChange={setPapersOnly}
              onChanged={() => filesChanged([''])} onOpenFile={openFile} />
            <FileBrowser
              workspaceId={workspaceId}
              papersOnly={papersOnly}
              revision={filesRevision}
              activePath={file}
              onOpenFile={openFile}
              onChanged={() => filesChanged([''])}
            />
          </div>
        </aside>
        <div
          className="split-handle materials-handle"
          {...layout.separator('materials')}
        />
        <ReaderToolbarProvider value={readerTools}>
        <FilePreview
          workspaceId={workspaceId}
          path={file}
          revision={(fileRevisions[file ?? ''] ?? 0) + (fileRevisions[''] ?? 0)}
          onPageChange={(page) => setPdfPosition({ path: file!, page })}
          mode={viewMode}
          request={readerRequest}
          onOpenFile={openFile}
          onBrowse={() => layout.setOpen('materials', true)}
          onCapture={async clip => {
            const id = await referenceConversation();
            if ((clips[id]?.length ?? 0) >= maxImageClips) throw new Error(t('errors.imageCount', {value0: maxImageClips}));
            const target = id;
            setClips(current => ({ ...current, [target]: [...(current[target] ?? []), clip] }));
            layout.setOpen('conversation', true);
          }}
          onQuote={async quote => {
            const id = await referenceConversation();
            if ((quotes[id]?.length ?? 0) >= maxTextQuotes) throw new Error(t('errors.quoteCount', {value0: maxTextQuotes}));
            setQuotes(current => ({ ...current, [id]: [...(current[id] ?? []), quote] }));
            layout.setOpen('conversation', true);
          }}
        />
        </ReaderToolbarProvider>
        <div
          className="split-handle conversation-handle"
          {...layout.separator('conversation')}
        />
        <section
          className={clsx('conversation-panel', layout.closing === 'conversation' && 'collapse-pending')}
          id="conversation-panel"
          data-collapse-label={t('workspaces.collapseConversation')}
          aria-label={t('conversations.title')}
          data-open={conversationOpen}
        >
          <div className="panel-content" inert={!conversationOpen} aria-hidden={!conversationOpen}>
            {modelError && (
              <p className="error-message" role="alert">
                {modelError}
              </p>
            )}
            {modelIssues.map((issue) => (
              <p className="error-message" role="alert" key={issue.provider}>
                {issue.provider}：{issue.message}
              </p>
            ))}
            {currentConversation ? (
              <ConversationPanel
                key={currentConversation.id}
                workspaceId={workspaceId}
                conversation={currentConversation}
                models={models}
                model={model}
                onModelChange={selectModel}
                reading={reading}
                clips={clips[currentConversation.id] ?? []}
                onClipsChange={value => setClips(current => ({ ...current, [currentConversation.id]: typeof value === 'function' ? value(current[currentConversation.id] ?? []) : value }))}
                quotes={quotes[currentConversation.id] ?? []}
                onQuotesChange={value => setQuotes(current => ({ ...current, [currentConversation.id]: typeof value === 'function' ? value(current[currentConversation.id] ?? []) : value }))}
                onOpenQuote={openDocument}
                onOpenDocument={openDocument}
              />
            ) : (
              <div className="chat-empty">
                <MessageSquare size={27} strokeWidth={1.3} />
                <h3>{t('conversations.none')}</h3>
                <ModelSettingsButton showLabel />
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
