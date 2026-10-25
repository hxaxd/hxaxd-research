'use client';

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
import { FilePreview } from '@/app/files/components/FilePreview';
import { FileBrowser } from '@/app/files/components/FileBrowser';
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
import { ChoiceSelect } from '@/shared/ui/ChoiceSelect';
import { EditableText } from '@/shared/ui/EntityControls';

import { WorkbenchHeader } from '@/app/WorkbenchHeader';
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
  const workspaceId = initialWorkspace.id;
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [conversations, setConversations] = useState(initialConversations);
  const [file, setFile] = useState(initialFile);
  const [directory, setDirectory] = useState(initialFile?.slice(0, Math.max(0, initialFile.lastIndexOf('/'))) ?? '');
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [readerRequest, setReaderRequest] = useState<DocumentRequest | null>(null);
  const [filesRevision, setFilesRevision] = useState(0);
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
      setFileError('文件变化监听已断开，正在重连；可手动刷新材料。');
    stream.onopen = () => {
      filesChanged(['']);
      setFileError('');
    };
    return () => {
      controller.abort();
      stream.close();
    };
  }, [workspaceId, filesChanged]);

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

  function openDocument(target: ReadingContext) {
    setFile(target.path);
    setDirectory(target.path.slice(0, Math.max(0, target.path.lastIndexOf('/'))));
    setViewMode(target.mode ?? 'preview');
    setPdfPosition({ path: target.path, page: target.page ?? 1 });
    setReaderRequest({ ...target, id: crypto.randomUUID() });
    updateQuery('file', target.path);
  }

  function openFile(path: string) {
    openDocument({ path });
    if (layout.tablet) layout.setOpen('materials', false);
  }

  function createdConversation(conversation: Conversation) {
    setConversations((current) => [...current, conversation]);
    selectConversation(conversation.id);
  }

  async function referenceConversation() {
    if (conversationId) return conversationId;
    const conversation = await requestJson<Conversation>(`/api/workspaces/${workspaceId}/conversations`, {
      method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), name: '材料提问' }),
    });
    createdConversation(conversation);
    return conversation.id;
  }

  return (
    <div className="app-shell">
      <WorkbenchHeader
        workspace={workspace}
        onRenamed={setWorkspace}
        workspaces={workspaces}
      />
      <main
        ref={workbenchRef}
        style={layout.style}
        className={`workbench${layout.dragging ? ' is-resizing' : ''}`}
      >
        {!materialsOpen && (
          <div className="collapsed-rail materials-rail">
            <button
              className="icon-button"
              aria-label="展开材料栏"
              title="展开材料栏"
              onClick={() => layout.setOpen('materials', true)}
            >
              <PanelLeftOpen size={18} />
            </button>
          </div>
        )}
        <aside
          className={`materials-panel${layout.closing === 'materials' ? ' collapse-pending' : ''}`}
          id="materials-panel"
          aria-label="论文与材料"
          hidden={!materialsOpen}
        >
          {fileError && (
            <p className="error-message" role="alert">
              {fileError}
            </p>
          )}
          <div className="panel-heading">
            <span>
              材料
            </span>
            <div className="toolbar">
              <button
                className="icon-button"
                aria-label="收起材料栏"
                title="收起材料栏"
                onClick={() => layout.setOpen('materials', false)}
              >
                <PanelLeftClose size={16} />
              </button>
            </div>
          </div>
          <FileBrowser
            workspaceId={workspaceId}
            directory={directory}
            onDirectoryChange={setDirectory}
            revision={filesRevision}
            activePath={file}
            onOpenFile={openFile}
          />
        </aside>
        <div
          className="split-handle materials-handle"
          {...layout.separator('materials')}
        />
        <FilePreview
          workspaceId={workspaceId}
          path={file}
          revision={(fileRevisions[file ?? ''] ?? 0) + (fileRevisions[''] ?? 0)}
          onPageChange={(page) => setPdfPosition({ path: file!, page })}
          mode={viewMode}
          onModeChange={setViewMode}
          request={readerRequest}
          onOpenFile={openFile}
          onBrowse={() => layout.setOpen('materials', true)}
          onCapture={async clip => {
            const id = await referenceConversation();
            if ((clips[id]?.length ?? 0) >= maxImageClips) throw new Error(`一次最多添加 ${maxImageClips} 张截图，请先发送或移除已有截图`);
            const target = id;
            setClips(current => ({ ...current, [target]: [...(current[target] ?? []), clip] }));
            layout.setOpen('conversation', true);
          }}
          onQuote={async quote => {
            const id = await referenceConversation();
            if ((quotes[id]?.length ?? 0) >= maxTextQuotes) throw new Error(`一次最多引用 ${maxTextQuotes} 段，请先发送或移除已有引用`);
            setQuotes(current => ({ ...current, [id]: [...(current[id] ?? []), quote] }));
            layout.setOpen('conversation', true);
          }}
        />
        <div
          className="split-handle conversation-handle"
          {...layout.separator('conversation')}
        />
        {!conversationOpen && (
          <div className="collapsed-rail conversation-rail">
            <button
              className="icon-button"
              aria-label="展开对话栏"
              title="展开对话栏"
              onClick={() => layout.setOpen('conversation', true)}
            >
              <PanelRightOpen size={18} />
            </button>
          </div>
        )}
        <section
          className={`conversation-panel${layout.closing === 'conversation' ? ' collapse-pending' : ''}`}
          id="conversation-panel"
          aria-label="材料对话"
          hidden={!conversationOpen}
        >
          <div className="panel-heading conversation-heading">
            <MessageSquare
              size={16}
              className="panel-icon"
              aria-hidden="true"
            />
            {currentConversation && (
              <EditableText
                className="conversation-name"
                value={currentConversation.name}
                label="对话名称"
                onSave={async (name) => {
                  const renamed = await requestJson<Conversation>(
                    `/api/workspaces/${workspaceId}/conversations/${currentConversation.id}`,
                    { method: 'PATCH', body: JSON.stringify({ name }) },
                  );
                  setConversations((current) =>
                    current.map((item) =>
                      item.id === renamed.id ? renamed : item,
                    ),
                  );
                }}
              />
            )}
            {conversations.length ? (
              <ChoiceSelect
                label="切换对话"
                value={conversationId ?? ''}
                items={conversations}
                onChange={selectConversation}
                iconOnly
              />
            ) : (
              <span className="conversation-heading-label">材料对话</span>
            )}
            <CreateConversationDialog
              workspaceId={workspaceId}
              onCreated={createdConversation}
            />
            <button
              className="icon-button"
              aria-label="收起对话栏"
              title="收起对话栏"
              onClick={() => layout.setOpen('conversation', false)}
            >
              <PanelRightClose size={16} />
            </button>
          </div>
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
              onOpenQuote={quote => {
                openDocument(quote);
                if (layout.tablet) layout.setOpen('materials', false);
              }}
            />
          ) : (
            <div className="chat-empty">
              <MessageSquare size={27} strokeWidth={1.3} />
              <h3>围绕材料，开始讨论</h3>
              <p>点击上方“新建”，讨论论文、梳理思路，或修改工作区中的文本。</p>
              <ModelSettingsButton showLabel />
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
