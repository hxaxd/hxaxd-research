import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../../shared/api/client";
import type {
  Annotation,
  AnnotationKind,
  Attachment,
  DocumentBlock,
  DocumentBlocksPage,
  Job,
  ReaderPreferences,
  ReadingBookmark,
  SemanticRole,
} from "../../shared/api/contracts";
import { useApiResource } from "../../shared/api/useApiResource";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import { Icon } from "../../shared/ui/Icon";
import {
  calculateScrollProgress,
  effectiveReadingMode,
  filterSemanticBlocks,
  searchSemanticBlocks,
  type ReadingMode,
} from "./semanticReading";
import "./semantic-reader.css";

type OcrMode = "auto" | "force" | "off";

const roleLabels: Record<SemanticRole, string> = {
  background: "背景",
  question: "问题",
  method: "方法",
  evidence: "证据",
  result: "结果",
  limitation: "局限",
  conclusion: "结论",
  other: "其他",
};

const annotationLabels: Record<AnnotationKind, string> = {
  highlight: "高亮",
  excerpt: "摘录",
  question: "问题",
  claim: "主张",
  method: "方法",
  result: "结果",
  limitation: "局限",
  bibliographic_note: "书目笔记",
};

const defaultPreferences: ReaderPreferences = {
  target_language: "zh-CN",
  default_mode: "source",
  default_panel: "structured",
  font_family: "serif",
  font_size: "medium",
  line_height: "standard",
  measure: "balanced",
  density: "comfortable",
  flow: "continuous",
  columns: "auto",
  theme: "dark",
  show_outline: true,
  restore_position: true,
  large_touch_targets: true,
  reduce_motion: false,
};

const terminalStatuses = new Set(["succeeded", "failed", "canceled"]);

interface Props {
  projectId: string;
  itemId: string;
  attachment: Attachment;
  annotationRefreshToken?: number;
  initialBlockId?: string | null;
  onReadingLocation?: (blockId: string, page: number | null) => void;
  onOpenPdf: (page: number | null) => void;
}

export function SemanticReader({ projectId, itemId, attachment, annotationRefreshToken = 0, initialBlockId = null, onReadingLocation, onOpenPdf }: Props) {
  const scrollRef = useRef<HTMLElement>(null);
  const saveTimer = useRef<number | null>(null);
  const restoredDocument = useRef<string | null>(null);
  const restoredDeepLink = useRef<string | null>(null);
  const preferencesApplied = useRef(false);
  const lastSavedPosition = useRef({ blockId: "", progress: -1 });
  const [readerSettings, setReaderSettings] = useState(defaultPreferences);
  const [mode, setMode] = useState<ReadingMode>(defaultPreferences.default_mode);
  const [role, setRole] = useState<SemanticRole | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [ocrMode, setOcrMode] = useState<OcrMode>("auto");
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyBlockId, setBusyBlockId] = useState<string | null>(null);
  const [composerBlockId, setComposerBlockId] = useState<string | null>(null);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [noteKind, setNoteKind] = useState<AnnotationKind>("highlight");
  const [noteBody, setNoteBody] = useState("");
  const [noteTags, setNoteTags] = useState("");
  const [noteQuote, setNoteQuote] = useState<string | null>(null);

  const preferences = useApiResource(() => api.userPreferences(), []);
  const annotations = useApiResource(
    () => api.annotations(projectId, itemId),
    [projectId, itemId, annotationRefreshToken],
  );
  const readingState = useApiResource(
    () => api.readingState(projectId, itemId),
    [projectId, itemId],
  );
  const documents = useApiResource(() => api.documents(itemId), [itemId]);
  const document = useMemo(
    () =>
      documents.data?.find(
        (candidate) =>
          candidate.source_attachment_id === attachment.id && candidate.status === "ready",
      ) ?? null,
    [attachment.id, documents.data],
  );
  const blocks = useApiResource<DocumentBlocksPage>(
    () =>
      document
        ? api.documentBlocks(document.id, readerSettings.target_language)
        : Promise.resolve({ document_id: "", offset: 0, limit: 1000, total: 0, items: [] }),
    [document?.id, readerSettings.target_language],
  );
  const activeJobId = activeJob?.id;
  const activeJobStatus = activeJob?.status;
  const reloadBlocks = blocks.reload;
  const reloadDocuments = documents.reload;

  useEffect(() => {
    if (!preferences.data || preferencesApplied.current) return;
    preferencesApplied.current = true;
    setReaderSettings(preferences.data.reader);
    setMode(preferences.data.reader.default_mode);
  }, [preferences.data]);

  useEffect(() => {
    if (!readingState.data) return;
    lastSavedPosition.current = {
      blockId: readingState.data.block_id ?? "",
      progress: readingState.data.progress,
    };
  }, [readingState.data]);

  useEffect(() => {
    if (!activeJobId || !activeJobStatus || terminalStatuses.has(activeJobStatus)) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void api
        .job(activeJobId)
        .then((next) => {
          if (disposed) return;
          setActiveJob(next);
          if (next.status === "succeeded") {
            void reloadDocuments();
            void reloadBlocks();
          }
        })
        .catch((reason: unknown) => {
          if (!disposed) {
            setActionError(reason instanceof Error ? reason.message : "任务状态读取失败");
          }
        });
    }, 700);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeJobId, activeJobStatus, reloadBlocks, reloadDocuments]);

  useEffect(() => {
    if (
      !document ||
      blocks.loading ||
      !blocks.data?.items.length
    ) {
      return;
    }
    const deepLink = initialBlockId
      ? blocks.data.items.find((block) => block.id === initialBlockId)
      : null;
    const deepLinkKey = deepLink ? `${document.id}:${deepLink.id}` : null;
    if (deepLink && restoredDeepLink.current !== deepLinkKey) {
      restoredDeepLink.current = deepLinkKey;
      restoredDocument.current = document.id;
      const frame = window.requestAnimationFrame(() => {
        globalThis.document
          .getElementById(`block-${deepLink.id}`)
          ?.scrollIntoView({ block: "center" });
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (
      !readingState.data ||
      !readerSettings.restore_position ||
      restoredDocument.current === document.id
    ) return;
    restoredDocument.current = document.id;
    const frame = window.requestAnimationFrame(() => {
      const savedBlock = readingState.data?.block_id;
      const target = savedBlock
        ? globalThis.document.getElementById(`block-${savedBlock}`)
        : null;
      if (target) {
        target.scrollIntoView({ block: "center" });
      } else if (scrollRef.current && readingState.data) {
        const maximum = scrollRef.current.scrollHeight - scrollRef.current.clientHeight;
        scrollRef.current.scrollTop = maximum * readingState.data.progress;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [blocks.data, blocks.loading, document, initialBlockId, readerSettings.restore_position, readingState.data]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const visibleBlocks = useMemo(
    () => searchSemanticBlocks(
      filterSemanticBlocks(blocks.data?.items ?? [], role),
      searchQuery,
    ),
    [blocks.data, role, searchQuery],
  );
  const translatedCount = (blocks.data?.items ?? []).filter(
    (block) => block.translation,
  ).length;
  const effectiveMode = effectiveReadingMode(mode, translatedCount);
  const outline = (blocks.data?.items ?? []).filter(
    (block) => block.kind === "title" || block.kind === "heading",
  );
  const annotationsByBlock = useMemo(() => {
    const grouped = new Map<string, Annotation[]>();
    for (const annotation of annotations.data ?? []) {
      if (!annotation.block_id) continue;
      const current = grouped.get(annotation.block_id) ?? [];
      current.push(annotation);
      grouped.set(annotation.block_id, current);
    }
    return grouped;
  }, [annotations.data]);
  const isRunning = activeJob && !terminalStatuses.has(activeJob.status);
  const bookmarks = readingState.data?.bookmarks ?? [];
  const layoutClass = [
    "semantic-layout",
    readerSettings.show_outline ? "semantic-layout--outline" : "semantic-layout--plain",
    workspaceOpen ? "semantic-layout--panel" : "",
  ].filter(Boolean).join(" ");

  function patchSettings(patch: Partial<ReaderPreferences>) {
    setReaderSettings((current) => ({ ...current, ...patch }));
  }

  function jumpToBlock(blockId: string) {
    const block = blocks.data?.items.find((candidate) => candidate.id === blockId);
    onReadingLocation?.(blockId, block?.page_start ?? null);
    globalThis.document
      .getElementById(`block-${blockId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function handleReaderScroll() {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const candidates = Array.from(
        scroller.querySelectorAll<HTMLElement>("[data-reading-block]"),
      );
      if (!candidates.length) return;
      const marker = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.32;
      let active = candidates[0];
      for (const candidate of candidates) {
        if (candidate.getBoundingClientRect().top <= marker) active = candidate;
        else break;
      }
      const blockId = active?.dataset.readingBlock ?? "";
      const block = blocks.data?.items.find((candidate) => candidate.id === blockId);
      const progress = calculateScrollProgress(
        scroller.scrollTop,
        scroller.scrollHeight,
        scroller.clientHeight,
      );
      const last = lastSavedPosition.current;
      if (blockId === last.blockId && Math.abs(progress - last.progress) < 0.02) return;
      lastSavedPosition.current = { blockId, progress };
      void api
        .updateReadingState(projectId, itemId, {
          attachment_id: attachment.id,
          block_id: blockId || null,
          page_number: block?.page_start ?? null,
          progress,
        })
        .then(readingState.setData)
        .catch((reason: unknown) => {
          setActionError(reason instanceof Error ? reason.message : "阅读进度保存失败");
        });
    }, 900);
  }

  async function startExtraction() {
    setActionError(null);
    try {
      setActiveJob(await api.extractDocument(attachment.id, ocrMode));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "无法开始结构化提取");
    }
  }

  async function startTranslation() {
    if (!document) return;
    setActionError(null);
    setNotice(null);
    try {
      const nextJob = await api.translateDocument(document.id, readerSettings.target_language);
      setActiveJob(nextJob);
      if (
        nextJob.status === "succeeded"
        && preferences.data?.translation.retranslate_scope === "changed"
      ) {
        setNotice("当前文档结构和翻译设置没有变化，已复用现有译文；可在设置中选择“整篇”强制重译。");
      }
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "无法开始整篇翻译");
    }
  }

  async function savePreferences() {
    if (!preferences.data) {
      setActionError("尚未读取到当前设置，请恢复连接后再保存。");
      return;
    }
    setActionError(null);
    setNotice(null);
    try {
      const saved = await api.updateUserPreferences({
        expected_revision: preferences.data.revision,
        reader: { ...readerSettings, default_mode: mode },
        bilingual: preferences.data?.bilingual ?? {
          layout: "side_by_side", highlight_terms: true, synchronize_blocks: true,
        },
        pdf: preferences.data?.pdf ?? {
          color_mode: "original", default_zoom: "page_width", toolbar_density: "comfortable", restore_position: true,
        },
        translation: preferences.data?.translation ?? {
          provider: "deepseek", model: "deepseek-v4-flash", style: "faithful_academic",
          batching: "whole_with_fallback", glossary: [], retranslate_scope: "changed",
        },
        agent: preferences.data?.agent ?? {
          model: null, reasoning_effort: "high", context_summary: "balanced",
          enabled_capabilities: ["catalog_read", "candidate_propose", "metadata_propose", "resource_propose", "zotero_conflict_propose", "web_search"],
        },
        tasks: preferences.data?.tasks ?? {
          notify_on_success: true, notify_on_failure: true, auto_open_result: false, max_concurrent_jobs: 2,
        },
      });
      preferences.setData(saved);
      setNotice("已保存为所有设备的阅读默认设置");
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "阅读设置保存失败");
      await preferences.reload();
    }
  }

  async function toggleBookmark(block: DocumentBlock) {
    const existing = bookmarks.find(
      (bookmark) => bookmark.block_id === block.id && bookmark.page_number === block.page_start,
    );
    setBusyBlockId(block.id);
    setActionError(null);
    try {
      const state = existing
        ? await api.deleteReadingBookmark(projectId, itemId, existing.id)
        : await api.addReadingBookmark(projectId, itemId, {
            block_id: block.id,
            page_number: block.page_start,
            label: block.source_text.slice(0, 120),
          });
      readingState.setData(state);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "书签操作失败");
    } finally {
      setBusyBlockId(null);
    }
  }

  function openComposer(block: DocumentBlock, annotation?: Annotation) {
    const source = globalThis.document
      .getElementById(`block-${block.id}`)
      ?.querySelector("[data-source-content]");
    const selection = window.getSelection();
    const exact = selection?.toString().trim() ?? "";
    const selectedSourceText = (
      exact
      && source
      && selection?.anchorNode
      && selection.focusNode
      && source.contains(selection.anchorNode)
      && source.contains(selection.focusNode)
      && block.source_text.includes(exact)
    ) ? exact : null;
    setComposerBlockId(block.id);
    setEditingAnnotationId(annotation?.id ?? null);
    setNoteKind(annotation?.kind ?? (block.semantic_role === "method" ? "method" : "highlight"));
    setNoteBody(annotation?.body ?? "");
    setNoteTags(annotation?.tags.join(", ") ?? "");
    setNoteQuote(annotation?.quoted_text ?? selectedSourceText);
  }

  function closeComposer() {
    setComposerBlockId(null);
    setEditingAnnotationId(null);
    setNoteBody("");
    setNoteTags("");
    setNoteQuote(null);
  }

  async function saveAnnotation(block: DocumentBlock) {
    const tags = noteTags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    setBusyBlockId(block.id);
    setActionError(null);
    try {
      if (editingAnnotationId) {
        const current = annotations.data?.find(
          (annotation) => annotation.id === editingAnnotationId,
        );
        if (!current) return;
        const saved = await api.updateAnnotation(current.id, {
          expected_updated_at: current.updated_at,
          kind: noteKind,
          body: noteBody,
          tags,
        });
        annotations.setData(
          (annotations.data ?? []).map((annotation) =>
            annotation.id === saved.id ? saved : annotation,
          ),
        );
      } else {
        const saved = await api.createAnnotation(projectId, itemId, {
          attachment_id: null,
          block_id: block.id,
          kind: noteKind,
          body: noteBody,
          quoted_text: noteQuote,
          page_number: null,
          anchor: noteQuote ? { selection_source: "source" } : {},
          tags,
        });
        annotations.setData([...(annotations.data ?? []), saved]);
      }
      closeComposer();
      setWorkspaceOpen(true);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "批注保存失败");
    } finally {
      setBusyBlockId(null);
    }
  }

  async function deleteAnnotation(annotation: Annotation) {
    setBusyBlockId(annotation.block_id);
    setActionError(null);
    try {
      await api.deleteAnnotation(annotation.id, annotation.updated_at);
      annotations.setData(
        (annotations.data ?? []).filter((candidate) => candidate.id !== annotation.id),
      );
      if (editingAnnotationId === annotation.id) closeComposer();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "批注删除失败");
    } finally {
      setBusyBlockId(null);
    }
  }

  if (documents.loading) {
    return <div className="semantic-reader"><AsyncMessage kind="loading">正在读取文档结构…</AsyncMessage></div>;
  }
  if (documents.error) {
    return <div className="semantic-reader"><AsyncMessage kind="error" onRetry={() => void documents.retry()}>{documents.error}</AsyncMessage></div>;
  }
  if (!document) {
    return <div className="semantic-reader semantic-reader--empty">
      <section className="semantic-onboarding">
        <span className="semantic-onboarding__icon"><Icon name="book-open" size={25} /></span>
        <span className="eyebrow">STRUCTURED READING</span>
        <h2>把线性 PDF 变成可筛选的阅读结构</h2>
        <p>存在 TeX 源附件时优先读取其章节、段落、公式和图表关系，再用 BabelDOC 补齐 PDF 页码与坐标；没有源码时直接复用 PDF 版面结构。</p>
        <label>扫描件策略
          <select value={ocrMode} onChange={(event) => setOcrMode(event.target.value as OcrMode)}>
            <option value="auto">自动检测</option>
            <option value="force">强制离线 OCR</option>
            <option value="off">跳过扫描检测</option>
          </select>
        </label>
        <button className="primary-button semantic-primary-action" disabled={Boolean(isRunning)} type="button" onClick={() => void startExtraction()}>
          <Icon name={isRunning ? "activity" : "sparkles"} size={17} />
          {isRunning ? "正在生成结构…" : "生成结构化内容"}
        </button>
        <small>自动模式优先使用 TeX 与原生文本层；没有文本层时回退到真正的离线 OCR，并保留页码、坐标与识别置信度。</small>
        {actionError || activeJob?.error_message ? <p className="semantic-action-error">{actionError || activeJob?.error_message}</p> : null}
      </section>
    </div>;
  }

  return <div className={[
    "semantic-reader",
    `semantic-reader--${readerSettings.font_size}`,
    `semantic-reader--${readerSettings.measure}`,
    `semantic-reader--${readerSettings.density}`,
    `semantic-reader--font-${readerSettings.font_family}`,
    `semantic-reader--line-${readerSettings.line_height}`,
    `semantic-reader--flow-${readerSettings.flow}`,
    `semantic-reader--columns-${readerSettings.columns}`,
    `semantic-reader--theme-${readerSettings.theme}`,
    preferences.data?.bilingual.layout === "stacked" ? "semantic-reader--bilingual-stacked" : "",
    readerSettings.reduce_motion ? "semantic-reader--reduce-motion" : "",
    readerSettings.large_touch_targets ? "semantic-reader--touch" : "",
  ].filter(Boolean).join(" ")}>
    <header className="semantic-toolbar">
      <div className="semantic-segments" aria-label="阅读语言">
        {(["source", "bilingual", "translation"] as ReadingMode[]).map((value) => <button aria-pressed={effectiveMode === value} className={effectiveMode === value ? "active" : ""} disabled={!translatedCount && value !== "source"} key={value} type="button" onClick={() => setMode(value)}>{value === "source" ? "原文" : value === "bilingual" ? "双语" : "译文"}</button>)}
      </div>
      <label className="semantic-role-filter"><span>语义</span><select value={role} onChange={(event) => setRole(event.target.value as SemanticRole | "all")}><option value="all">全部节奏</option>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="semantic-search"><Icon name="search" size={14} /><input aria-label="全文搜索" placeholder="搜索原文或译文" type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />{searchQuery ? <button aria-label="清除搜索" type="button" onClick={() => setSearchQuery("")}><Icon name="close" size={13} /></button> : null}</label>
      <span className="semantic-toolbar__status">{document.block_count} 块 · {translatedCount} 已译 · {Math.round((readingState.data?.progress ?? 0) * 100)}%</span>
      <button className={workspaceOpen ? "toolbar-button active" : "toolbar-button"} type="button" aria-expanded={workspaceOpen} onClick={() => setWorkspaceOpen((value) => !value)}><Icon name="note" size={15} />笔记 {annotations.data?.length ?? 0}<span className="toolbar-count">{bookmarks.length}</span></button>
      <button className="toolbar-button" type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}><Icon name="settings" size={15} />设置</button>
      <button className="primary-toolbar-button" disabled={Boolean(isRunning)} type="button" onClick={() => void startTranslation()}><Icon name={isRunning ? "activity" : "languages"} size={15} />{isRunning ? "处理中" : translatedCount ? "重新翻译与识别" : "翻译与语义识别"}</button>
    </header>
    {settingsOpen ? <section className="semantic-settings" aria-label="阅读设置">
      <label>目标语言<select value={readerSettings.target_language} onChange={(event) => patchSettings({ target_language: event.target.value })}><option value="zh-CN">简体中文</option><option value="zh-TW">繁体中文</option><option value="en">English</option></select></label>
      <label>字号<select value={readerSettings.font_size} onChange={(event) => patchSettings({ font_size: event.target.value as ReaderPreferences["font_size"] })}><option value="small">紧凑</option><option value="medium">标准</option><option value="large">大字</option></select></label>
      <label>行距<select value={readerSettings.line_height} onChange={(event) => patchSettings({ line_height: event.target.value as ReaderPreferences["line_height"] })}><option value="compact">紧凑</option><option value="standard">标准</option><option value="relaxed">舒展</option></select></label>
      <label>行宽<select value={readerSettings.measure} onChange={(event) => patchSettings({ measure: event.target.value as ReaderPreferences["measure"] })}><option value="focused">专注</option><option value="balanced">均衡</option><option value="wide">宽屏</option></select></label>
      <label>块间距<select value={readerSettings.density} onChange={(event) => patchSettings({ density: event.target.value as ReaderPreferences["density"] })}><option value="compact">紧密</option><option value="comfortable">舒展</option></select></label>
      <div className="semantic-settings__toggles">
        <label><input checked={readerSettings.show_outline} type="checkbox" onChange={(event) => patchSettings({ show_outline: event.target.checked })} />显示目录</label>
        <label><input checked={readerSettings.restore_position} type="checkbox" onChange={(event) => patchSettings({ restore_position: event.target.checked })} />恢复进度</label>
        <label><input checked={readerSettings.large_touch_targets} type="checkbox" onChange={(event) => patchSettings({ large_touch_targets: event.target.checked })} />大触控区</label>
      </div>
      <button className="settings-save-button" disabled={preferences.loading || !preferences.data} type="button" onClick={() => void savePreferences()}><Icon name="check" size={15} />保存为所有设备默认</button>
    </section> : null}
    {notice ? <div className="semantic-job-message semantic-job-message--success">{notice}</div> : null}
    {actionError || activeJob?.error_message ? <div className="semantic-job-message semantic-job-message--error">{actionError || activeJob?.error_message}</div> : isRunning ? <div className="semantic-job-message"><Icon name="activity" size={14} />后台任务进行中；可以继续阅读现有内容。</div> : null}
    <div className={layoutClass}>
      {readerSettings.show_outline ? <nav className="semantic-outline" aria-label="文档目录">
        <span>文档节奏</span>
        {outline.map((block) => <button key={block.id} type="button" onClick={() => jumpToBlock(block.id)}>{block.source_text}</button>)}
      </nav> : null}
      <main className="semantic-scroll" onScroll={handleReaderScroll} ref={scrollRef}>
        <article className="semantic-document">
          {blocks.loading ? <AsyncMessage kind="loading">正在装配阅读块…</AsyncMessage> : null}
          {blocks.error ? <AsyncMessage kind="error" onRetry={() => void blocks.retry()}>{blocks.error}</AsyncMessage> : null}
          {!blocks.loading && !visibleBlocks.length ? <AsyncMessage kind="empty">当前筛选没有匹配的阅读块</AsyncMessage> : null}
          {visibleBlocks.map((block) => <SemanticBlockCard
            annotations={annotationsByBlock.get(block.id) ?? []}
            block={block}
            bookmark={bookmarks.find((item) => item.block_id === block.id)}
            busy={busyBlockId === block.id}
            composer={composerBlockId === block.id}
            editingAnnotationId={editingAnnotationId}
            key={block.id}
            mode={effectiveMode}
            noteBody={noteBody}
            noteKind={noteKind}
            noteQuote={noteQuote}
            noteTags={noteTags}
            onBookmark={() => void toggleBookmark(block)}
            onCancelComposer={closeComposer}
            onDeleteAnnotation={(annotation) => void deleteAnnotation(annotation)}
            onEditAnnotation={(annotation) => openComposer(block, annotation)}
            onNoteBody={setNoteBody}
            onNoteKind={setNoteKind}
            onNoteTags={setNoteTags}
            onOpenComposer={() => openComposer(block)}
            onOpenPdf={onOpenPdf}
            onSaveAnnotation={() => void saveAnnotation(block)}
          />)}
        </article>
      </main>
      {workspaceOpen ? <ReadingWorkspace
        annotations={annotations.data ?? []}
        bookmarks={bookmarks}
        onClose={() => setWorkspaceOpen(false)}
        onDeleteAnnotation={(annotation) => void deleteAnnotation(annotation)}
        onJump={jumpToBlock}
        progress={readingState.data?.progress ?? 0}
      /> : null}
    </div>
  </div>;
}

interface BlockCardProps {
  block: DocumentBlock;
  mode: ReadingMode;
  annotations: Annotation[];
  bookmark: ReadingBookmark | undefined;
  busy: boolean;
  composer: boolean;
  editingAnnotationId: string | null;
  noteKind: AnnotationKind;
  noteQuote: string | null;
  noteBody: string;
  noteTags: string;
  onOpenPdf: (page: number | null) => void;
  onBookmark: () => void;
  onOpenComposer: () => void;
  onEditAnnotation: (annotation: Annotation) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  onNoteKind: (kind: AnnotationKind) => void;
  onNoteBody: (body: string) => void;
  onNoteTags: (tags: string) => void;
  onSaveAnnotation: () => void;
  onCancelComposer: () => void;
}

function SemanticBlockCard({
  block,
  mode,
  annotations,
  bookmark,
  busy,
  composer,
  editingAnnotationId,
  noteKind,
  noteQuote,
  noteBody,
  noteTags,
  onOpenPdf,
  onBookmark,
  onOpenComposer,
  onEditAnnotation,
  onDeleteAnnotation,
  onNoteKind,
  onNoteBody,
  onNoteTags,
  onSaveAnnotation,
  onCancelComposer,
}: BlockCardProps) {
  const heading = block.kind === "title" || block.kind === "heading";
  const source = heading ? <h2>{block.source_text}</h2> : <p>{block.source_text}</p>;
  const translation = block.translation
    ? heading
      ? <h2>{block.translation.translated_text}</h2>
      : <p>{block.translation.translated_text}</p>
    : <p className="semantic-untranslated">尚无此语言的译文</p>;
  return <section className={`semantic-block semantic-block--${block.kind}`} data-reading-block={block.id} id={`block-${block.id}`}>
    <div className="semantic-block__meta">
      {block.semantic_role ? <span className={`role-chip role-chip--${block.semantic_role}`}>{roleLabels[block.semantic_role]}</span> : <span className="role-chip">未分类</span>}
      <button type="button" onClick={() => onOpenPdf(block.page_start)}>{block.page_start ? `第 ${block.page_start} 页` : "无页码"}<Icon name="arrow-right" size={12} /></button>
      <span className="semantic-block__spacer" />
      <button aria-label={bookmark ? "取消书签" : "添加书签"} className={bookmark ? "semantic-icon-action active" : "semantic-icon-action"} disabled={busy} type="button" onClick={onBookmark}><Icon name="bookmark" size={15} /><span>{bookmark ? "已收藏" : "书签"}</span></button>
      <button className="semantic-icon-action" disabled={busy} type="button" onClick={onOpenComposer}><Icon name="note" size={15} /><span>批注</span></button>
    </div>
    <div className={`semantic-block__content semantic-block__content--${mode}`}>
      {mode !== "translation" ? <div data-source-content lang="en">{source}</div> : null}
      {mode !== "source" ? <div lang="zh-CN">{translation}</div> : null}
    </div>
    {annotations.length ? <div className="block-annotations">
      {annotations.map((annotation) => <article className={`block-note block-note--${annotation.kind}`} key={annotation.id}>
        <header><span>{annotationLabels[annotation.kind]}</span><div><button aria-label="编辑批注" type="button" onClick={() => onEditAnnotation(annotation)}><Icon name="edit" size={13} /></button><button aria-label="删除批注" type="button" onClick={() => onDeleteAnnotation(annotation)}><Icon name="trash" size={13} /></button></div></header>
        {annotation.body ? <p>{annotation.body}</p> : <p className="block-note__quote">已标记本段</p>}
        {annotation.tags.length ? <footer>{annotation.tags.map((tag) => <span key={tag}>#{tag}</span>)}</footer> : null}
      </article>)}
    </div> : null}
    {composer ? <form className="annotation-composer" onSubmit={(event) => { event.preventDefault(); onSaveAnnotation(); }}>
      <div className="annotation-composer__header"><strong>{editingAnnotationId ? "编辑批注" : "记录这一段"}</strong><button aria-label="关闭批注编辑器" type="button" onClick={onCancelComposer}><Icon name="close" size={15} /></button></div>
      {noteQuote ? <blockquote className="annotation-composer__quote">“{noteQuote}”</blockquote> : null}
      <label>类型<select value={noteKind} onChange={(event) => onNoteKind(event.target.value as AnnotationKind)}>{Object.entries(annotationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="annotation-composer__body">内容<textarea autoFocus placeholder="写下问题、判断或可复用的研究线索…" rows={3} value={noteBody} onChange={(event) => onNoteBody(event.target.value)} /></label>
      <label>标签<input placeholder="方法, 复现" value={noteTags} onChange={(event) => onNoteTags(event.target.value)} /></label>
      <div className="annotation-composer__actions"><button type="button" onClick={onCancelComposer}>取消</button><button className="primary-toolbar-button" disabled={busy} type="submit">{busy ? "保存中…" : "保存批注"}</button></div>
    </form> : null}
  </section>;
}

function ReadingWorkspace({
  annotations,
  bookmarks,
  progress,
  onClose,
  onJump,
  onDeleteAnnotation,
}: {
  annotations: Annotation[];
  bookmarks: ReadingBookmark[];
  progress: number;
  onClose: () => void;
  onJump: (blockId: string) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
}) {
  return <aside className="reading-notes-panel" aria-label="阅读笔记">
    <header><div><span className="eyebrow">READING MEMORY</span><h2>阅读工作区</h2></div><button aria-label="关闭阅读工作区" type="button" onClick={onClose}><Icon name="close" size={17} /></button></header>
    <section className="reading-progress-card"><div><strong>{Math.round(progress * 100)}%</strong><span>本篇进度</span></div><div className="reading-progress-track"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div></section>
    <section><h3><Icon name="bookmark" size={14} />书签 <span>{bookmarks.length}</span></h3>{bookmarks.length ? <div className="reading-memory-list">{bookmarks.map((bookmark) => <button key={bookmark.id} type="button" onClick={() => bookmark.block_id && onJump(bookmark.block_id)}><strong>{bookmark.label}</strong><small>{bookmark.page_number ? `第 ${bookmark.page_number} 页` : "语义位置"}</small></button>)}</div> : <p className="reading-panel-empty">从段落右上角添加书签。</p>}</section>
    <section><h3><Icon name="note" size={14} />批注 <span>{annotations.length}</span></h3>{annotations.length ? <div className="reading-memory-list">{annotations.map((annotation) => <article key={annotation.id}><button type="button" onClick={() => annotation.block_id && onJump(annotation.block_id)}><small>{annotationLabels[annotation.kind]}{annotation.page_number ? ` · 第 ${annotation.page_number} 页` : ""}</small><strong>{annotation.body || annotation.quoted_text?.slice(0, 100) || "已标记段落"}</strong></button><button aria-label="删除批注" type="button" onClick={() => onDeleteAnnotation(annotation)}><Icon name="trash" size={13} /></button></article>)}</div> : <p className="reading-panel-empty">批注会与稳定段落锚点一起保存。</p>}</section>
  </aside>;
}
