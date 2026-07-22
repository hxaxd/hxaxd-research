import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";

import { firstReadableAttachment } from "../../features/reader/artifactVariants";
import {
  PdfViewer,
  type PdfColorMode,
  type PdfTextSelection,
} from "../../features/reader/PdfViewer";
import { ReaderToolbar } from "../../features/reader/ReaderToolbar";
import { SemanticReader } from "../../features/reader/SemanticReader";
import { SplitReader } from "../../features/reader/SplitReader";
import { ProjectInsightEditor } from "../../features/projects/ProjectInsightEditor";
import { ResourceActions } from "../../features/resources/ResourceActions";
import { AgentTaskLauncher } from "../../features/tasks/AgentTaskLauncher";
import { api } from "../../shared/api/client";
import type {
  Annotation,
  AnnotationKind,
  Attachment,
  ItemHistory,
} from "../../shared/api/contracts";
import { useApiResource } from "../../shared/api/useApiResource";
import { formatBytes, formatDateTime } from "../../shared/lib/format";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import { Icon } from "../../shared/ui/Icon";
import "./pages.css";

const compactReaderQuery = "(max-width: 1180px)";

export function ItemPage() {
  const { projectId, itemId, attachmentId } = useParams<{
    projectId: string;
    itemId: string;
    attachmentId?: string;
  }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedBlockId = searchParams.get("block");
  const linkedPage = parseLinkedPage(searchParams.get("page"));
  const linkedPanel = parseLinkedPanel(searchParams.get("panel"));
  const readerQuery = searchParams.toString();
  const workspace = useRef<HTMLDivElement>(null);
  const pdfProgressTimer = useRef<number | null>(null);
  const [colorMode, setColorMode] = useState<PdfColorMode>("normal");
  const [readerMode, setReaderMode] = useState<"pdf" | "semantic" | "split">(
    linkedBlockId ? "semantic" : (linkedPanel ?? "pdf"),
  );
  const preferencesApplied = useRef(false);
  const [requestedPage, setRequestedPage] = useState<number | null>(linkedPage);
  const [annotationRefreshToken, setAnnotationRefreshToken] = useState(0);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [preferenceMessage, setPreferenceMessage] = useState<string | null>(
    null,
  );
  const [inspectorOpen, setInspectorOpen] = useState(
    () => !window.matchMedia(compactReaderQuery).matches,
  );
  const [compactReader, setCompactReader] = useState(
    () => window.matchMedia(compactReaderQuery).matches,
  );
  const resource = useApiResource(
    () =>
      itemId && projectId
        ? Promise.all([
            api.item(itemId),
            api.attachments(itemId),
            api.userPreferences(),
            api.projectItems(projectId, "all"),
            api.documents(itemId),
            api.itemHistory(itemId),
          ])
        : Promise.reject(new Error("文献地址无效")),
    [itemId, projectId],
  );
  const pdfAnnotations = useApiResource(
    () =>
      itemId && projectId
        ? api.annotations(projectId, itemId)
        : Promise.resolve([]),
    [annotationRefreshToken, itemId, projectId],
  );
  const pdfReadingState = useApiResource(
    () =>
      itemId && projectId
        ? api.readingState(projectId, itemId)
        : Promise.reject(new Error("文献地址无效")),
    [itemId, projectId],
  );
  const selected = useMemo(() => {
    const attachments = resource.data?.[1] ?? [];
    return (
      attachments.find(
        (item) => item.id === attachmentId && item.format === "pdf",
      ) ??
      firstReadableAttachment(attachments)
    );
  }, [attachmentId, resource.data]);

  useEffect(() => {
    if (!projectId || !itemId || !selected || attachmentId === selected.id)
      return;
    navigate(
      `/projects/${projectId}/items/${itemId}/read/${selected.id}${readerQuery ? `?${readerQuery}` : ""}`,
      { replace: true },
    );
  }, [attachmentId, itemId, navigate, projectId, readerQuery, selected]);

  useEffect(() => {
    const preferences = resource.data?.[2];
    if (!preferences || preferencesApplied.current) return;
    preferencesApplied.current = true;
    const hasStructuredDocument = resource.data?.[4].some(
      (document) =>
        document.source_attachment_id === selected?.id &&
        document.status === "ready",
    );
    const preferredPanel =
      preferences.reader.default_panel === "structured"
        ? "semantic"
        : preferences.reader.default_panel;
    setReaderMode(
      linkedBlockId
        ? "semantic"
        : (linkedPanel ??
            (preferredPanel === "semantic" && !hasStructuredDocument
              ? "pdf"
              : preferredPanel)),
    );
    setColorMode(
      preferences.pdf.color_mode === "original"
        ? "normal"
        : preferences.pdf.color_mode,
    );
  }, [linkedBlockId, linkedPanel, resource.data, selected?.id]);

  useEffect(() => {
    if (linkedPage !== null) setRequestedPage(linkedPage);
    if (linkedBlockId) setReaderMode("semantic");
    else if (linkedPanel) setReaderMode(linkedPanel);
  }, [linkedBlockId, linkedPage, linkedPanel]);

  useEffect(() => {
    const media = window.matchMedia(compactReaderQuery);
    const updateCompactLayout = () => {
      setCompactReader(media.matches);
      if (media.matches) setInspectorOpen(false);
    };
    media.addEventListener("change", updateCompactLayout);
    return () => media.removeEventListener("change", updateCompactLayout);
  }, []);

  useEffect(
    () => () => {
      if (pdfProgressTimer.current !== null)
        window.clearTimeout(pdfProgressTimer.current);
    },
    [],
  );

  if (resource.loading)
    return <AsyncMessage kind="loading">正在打开文献…</AsyncMessage>;
  if (resource.error)
    return (
      <AsyncMessage kind="error" onRetry={() => void resource.retry()}>
        {resource.error}
      </AsyncMessage>
    );
  if (!projectId || !itemId || !resource.data)
    return <AsyncMessage kind="empty">文献不存在</AsyncMessage>;
  const [item, attachments, preferences, projectItems, , history] =
    resource.data;
  const projectItem =
    projectItems.find((entry) => entry.work_id === item.work_id) ?? null;
  const creatorLine = item.creators
    .map(
      (creator) =>
        creator.literal_name ||
        [creator.given_name, creator.family_name].filter(Boolean).join(" ") ||
        creator.raw_name,
    )
    .join("、");

  function choose(attachment: Attachment) {
    navigate(
      `/projects/${projectId}/items/${itemId}/read/${attachment.id}${readerQuery ? `?${readerQuery}` : ""}`,
    );
  }

  function updateReaderQuery(values: {
    panel?: "pdf" | "semantic" | "split";
    block?: string | null;
    page?: number | null;
  }) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(values)) {
          if (value === null || value === undefined || value === "")
            next.delete(key);
          else next.set(key, String(value));
        }
        return next;
      },
      { replace: true },
    );
  }

  function chooseReaderMode(mode: "pdf" | "semantic" | "split") {
    setReaderMode(mode);
    updateReaderQuery(
      mode === "semantic" ? { panel: mode } : { panel: mode, block: null },
    );
  }

  async function annotatePdf(
    selection: PdfTextSelection,
    kind: AnnotationKind,
  ) {
    if (!projectId || !itemId || !selected)
      throw new Error("没有可用于批注的 PDF 附件");
    const saved = await api.createAnnotation(projectId, itemId, {
      attachment_id: selected.id,
      block_id: null,
      kind,
      body: "",
      quoted_text: selection.text,
      page_number: selection.pageNumber,
      anchor: {
        ...selection.anchor,
        text_quote: { type: "TextQuoteSelector", exact: selection.text },
      },
      tags: [],
    });
    pdfAnnotations.setData([...(pdfAnnotations.data ?? []), saved]);
    setAnnotationRefreshToken((value) => value + 1);
  }

  async function deletePdfAnnotation(annotation: Annotation) {
    await api.deleteAnnotation(annotation.id, annotation.updated_at);
    pdfAnnotations.setData(
      (pdfAnnotations.data ?? []).filter(
        (candidate) => candidate.id !== annotation.id,
      ),
    );
    setAnnotationRefreshToken((value) => value + 1);
  }

  function rememberPdfPage(pageNumber: number, pageCount: number) {
    if (!projectId || !itemId || !selected) return;
    if (pdfProgressTimer.current !== null)
      window.clearTimeout(pdfProgressTimer.current);
    pdfProgressTimer.current = window.setTimeout(() => {
      void api
        .updateReadingState(projectId, itemId, {
          attachment_id: selected.id,
          block_id: null,
          page_number: pageNumber,
          progress: pageCount > 0 ? pageNumber / pageCount : 0,
        })
        .then(pdfReadingState.setData)
        .catch(() => undefined);
    }, 600);
  }

  async function preferCurrentAttachment() {
    if (!selected || !itemId) return;
    setPreferenceBusy(true);
    setPreferenceMessage(null);
    try {
      await api.setAttachmentPreference(itemId, "reading", selected.id);
      await resource.reload();
      setPreferenceMessage("已设为默认阅读附件");
    } catch (reason) {
      setPreferenceMessage(
        reason instanceof Error ? reason.message : "默认附件设置失败",
      );
    } finally {
      setPreferenceBusy(false);
    }
  }

  const savedPdfPosition = pdfReadingState.data;
  const restoredPdfPage =
    preferences.pdf.restore_position &&
    savedPdfPosition &&
    savedPdfPosition?.attachment_id === selected?.id
      ? savedPdfPosition.page_number
      : null;
  const currentPdfAnnotations = (pdfAnnotations.data ?? []).filter(
    (annotation) => annotation.attachment_id === selected?.id,
  );
  const pdf = selected ? (
    <PdfViewer
      annotations={currentPdfAnnotations}
      key={`${selected.id}-${selected.sha256}`}
      url={api.attachmentUrl(selected.id, selected.sha256)}
      colorMode={colorMode}
      initialPage={requestedPage ?? restoredPdfPage}
      initialZoom={
        preferences.pdf.default_zoom === "page_width"
          ? "page-width"
          : preferences.pdf.default_zoom === "page_fit"
            ? "page-fit"
            : "auto"
      }
      toolbarDensity={preferences.pdf.toolbar_density}
      onAnnotateSelection={annotatePdf}
      onDeleteAnnotation={deletePdfAnnotation}
      onPageChange={rememberPdfPage}
    />
  ) : null;
  const semantic = selected ? (
    <SemanticReader
      projectId={projectId}
      itemId={itemId}
      attachment={selected}
      annotationRefreshToken={annotationRefreshToken}
      initialBlockId={linkedBlockId}
      onReadingLocation={(blockId, page) =>
        updateReaderQuery({ panel: "semantic", block: blockId, page })
      }
      onOpenPdf={(page) => {
        setRequestedPage(page);
        setReaderMode("pdf");
        updateReaderQuery({ panel: "pdf", block: null, page });
      }}
    />
  ) : null;
  return (
    <section className="item-page" ref={workspace}>
      <header className="item-header">
        <Link
          className="paper-back-link"
          to={`/projects/${projectId}?tab=library`}
          title="返回项目"
        >
          <Icon name="arrow-left" size={18} />
        </Link>
        <div>
          <span>
            {item.item_type} · {item.issued_year ?? "年份未知"} ·{" "}
            {creatorLine || "作者未知"}
          </span>
          <h1>{item.translated_title || item.title}</h1>
          {item.translated_title ? <p>{item.title}</p> : null}
        </div>
        <button
          className={inspectorOpen ? "toolbar-button active" : "toolbar-button"}
          type="button"
          onClick={() => setInspectorOpen((value) => !value)}
        >
          <Icon name="panel-left" size={15} />
          信息
        </button>
      </header>
      <div
        className={
          inspectorOpen
            ? "reading-workspace"
            : "reading-workspace reading-workspace--wide"
        }
      >
        <div className="reader-frame">
          <ReaderToolbar
            attachments={attachments}
            selected={selected?.language_mode ?? null}
            colorMode={colorMode}
            readerMode={readerMode}
            onReaderMode={chooseReaderMode}
            onSelect={choose}
            onColorMode={setColorMode}
            onFullscreen={() => void workspace.current?.requestFullscreen()}
            actions={
              selected ? (
                <a
                  aria-label="下载 PDF"
                  className="toolbar-button"
                  href={api.attachmentDownloadUrl(selected.id)}
                  title="下载 PDF"
                >
                  <Icon name="download" size={15} />
                  <span>下载</span>
                </a>
              ) : null
            }
          />
          {selected ? (
            readerMode === "split" ? (
              <SplitReader pdf={pdf} semantic={semantic} />
            ) : readerMode === "semantic" ? (
              semantic
            ) : (
              pdf
            )
          ) : (
            <div className="reader-empty">
              <Icon name="file-text" size={26} />
              <h2>尚无可阅读的 PDF</h2>
              <p>可以在右侧上传、获取或编译资源。</p>
            </div>
          )}
        </div>
        {inspectorOpen && compactReader ? (
          <button
            aria-label="关闭文献信息"
            className="item-inspector-backdrop"
            type="button"
            onClick={() => setInspectorOpen(false)}
          />
        ) : null}
        {inspectorOpen ? (
          <aside
            aria-label="文献信息与操作"
            aria-modal={compactReader || undefined}
            className="item-inspector"
            role={compactReader ? "dialog" : undefined}
          >
            <button
              aria-label="关闭文献信息"
              className="item-inspector-close"
              type="button"
              onClick={() => setInspectorOpen(false)}
            >
              <Icon name="close" size={17} />
            </button>
            <section>
              <span className="eyebrow">文献信息</span>
              <h2>书目信息</h2>
              <dl>
                <dt>作者</dt>
                <dd>
                  {creatorLine || "未知"}
                  {!item.creator_list_complete ? "（作者列表不完整）" : ""}
                </dd>
                <dt>发表</dt>
                <dd>
                  {item.container_title || item.publisher || "未知来源"} ·{" "}
                  {item.issued_literal || item.issued_year || "日期未知"}
                </dd>
                <dt>摘要</dt>
                <dd>{item.abstract || "尚未收录摘要"}</dd>
                <dt>标识符</dt>
                <dd>
                  {item.identifiers.map((identifier) => (
                    <code key={identifier.id}>
                      {identifier.scheme}:{identifier.value}
                    </code>
                  ))}
                </dd>
              </dl>
            </section>
            <AgentTaskLauncher
              fixedItemScope={{
                projectId,
                itemId,
                label: item.translated_title || item.title,
              }}
            />
            {projectItem ? (
              <ProjectInsightEditor
                projectId={projectId}
                initial={projectItem}
              />
            ) : null}
            <ResourceActions
              itemId={itemId}
              attachments={attachments}
              onAttachmentChanged={resource.reload}
            />
            <section>
              <h2>附件</h2>
              <div className="attachment-list">
                {attachments.map((attachment) => (
                  <button
                    className={attachment.id === selected?.id ? "active" : ""}
                    disabled={attachment.format !== "pdf"}
                    key={attachment.id}
                    title={
                      attachment.format === "pdf"
                        ? "在阅读器中打开"
                        : "此附件请在资源区下载或处理"
                    }
                    type="button"
                    onClick={() => choose(attachment)}
                  >
                    <Icon
                      name={
                        attachment.format === "pdf" ? "file-text" : "terminal"
                      }
                      size={15}
                    />
                    <span>
                      <strong>{attachment.filename}</strong>
                      <small>
                        {attachment.language_mode} ·{" "}
                        {formatBytes(attachment.size)} · {attachment.origin}
                        {attachment.preferred_for.includes("reading")
                          ? " · 默认"
                          : ""}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              {selected ? (
                <button
                  className="attachment-preference-button"
                  disabled={
                    preferenceBusy || selected.preferred_for.includes("reading")
                  }
                  type="button"
                  onClick={() => void preferCurrentAttachment()}
                >
                  <Icon name="bookmark" size={14} />
                  {selected.preferred_for.includes("reading")
                    ? "当前默认阅读附件"
                    : preferenceBusy
                      ? "正在设置…"
                      : "设为默认阅读附件"}
                </button>
              ) : null}
              {preferenceMessage ? (
                <p className="attachment-preference-message" role="status">
                  {preferenceMessage}
                </p>
              ) : null}
            </section>
            <section>
              <h2>来源链接</h2>
              {item.links.length ? (
                item.links.map((link) => (
                  <a
                    className="source-link"
                    href={link.url}
                    key={link.id}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icon name="external-link" size={14} />
                    {link.title || link.relation_type}
                  </a>
                ))
              ) : (
                <p>暂无来源链接。</p>
              )}
            </section>
            <ItemHistoryPanel history={history} />
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function ItemHistoryPanel({ history }: { history: ItemHistory }) {
  const recordCount =
    history.revisions.length +
    history.field_sources.length +
    history.attachment_relations.length +
    history.audit_events.length;
  return (
    <details className="item-history">
      <summary>
        <span>
          <Icon name="activity" size={15} />
          来源与修改历史
        </span>
        <small>{recordCount} 条可追溯记录</small>
      </summary>
      <div className="item-history__body">
        <section>
          <h3>字段来源</h3>
          {history.field_sources.length ? (
            <ul className="item-history__list">
              {history.field_sources.map((source) => (
                <li key={source.field_path}>
                  <strong>{historyFieldLabel(source.field_path)}</strong>
                  <span>
                    {source.source_url ? (
                      <a href={source.source_url} target="_blank" rel="noreferrer">
                        {source.provider}
                        <Icon name="external-link" size={12} />
                      </a>
                    ) : (
                      source.provider
                    )}
                    {source.external_key ? ` · ${source.external_key}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>这条文献尚无独立字段来源记录。</p>
          )}
        </section>
        <section>
          <h3>书目修订</h3>
          {history.revisions.length ? (
            <ol className="item-history__timeline">
              {history.revisions.map((revision) => {
                const fields = Object.keys(revision.changes);
                return (
                  <li key={revision.id}>
                    <span>第 {revision.revision} 版</span>
                    <strong>
                      {fields.length
                        ? fields.map(historyFieldLabel).join("、")
                        : "建立书目记录"}
                    </strong>
                    <time dateTime={revision.created_at}>
                      {formatDateTime(revision.created_at)}
                    </time>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p>尚无修订记录。</p>
          )}
        </section>
        {history.attachment_relations.length ? (
          <section>
            <h3>文件派生关系</h3>
            <ul className="item-history__list">
              {history.attachment_relations.map((relation) => (
                <li
                  key={`${relation.parent_attachment_id}-${relation.child_attachment_id}-${relation.relation_type}`}
                >
                  <strong>{attachmentRelationLabel(relation.relation_type)}</strong>
                  <span>
                    {relation.parent_filename} → {relation.child_filename}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {history.audit_events.length ? (
          <section>
            <h3>关键操作</h3>
            <ol className="item-history__timeline">
              {history.audit_events.map((event) => (
                <li key={event.id}>
                  <strong>{auditActionLabel(event.action)}</strong>
                  <time dateTime={event.occurred_at}>
                    {formatDateTime(event.occurred_at)}
                  </time>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
    </details>
  );
}

const historyFieldLabels: Record<string, string> = {
  title: "标题",
  translated_title: "译名",
  abstract: "摘要",
  creators: "作者",
  identifiers: "标识符",
  links: "来源链接",
  issued: "出版日期",
  container_title: "出版物",
  publisher: "出版方",
  language: "语言",
};

function historyFieldLabel(path: string): string {
  const field = path.replace(/^\//, "").split(/[/.]/).at(-1) ?? path;
  return historyFieldLabels[field] ?? field.replaceAll("_", " ");
}

function attachmentRelationLabel(relation: string): string {
  const labels: Record<string, string> = {
    generated_from: "生成自",
    translated_from: "翻译自",
    compiled_from: "编译自",
    extracted_from: "提取自",
  };
  return labels[relation] ?? "派生文件";
}

function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    "item.created": "建立书目",
    "item.updated": "更新书目",
    "document.extracted": "完成结构识别",
    "document.translated": "完成翻译",
    "annotation.created": "新建批注",
    "annotation.updated": "修改批注",
  };
  return labels[action] ?? action.split(".").at(-1)?.replaceAll("_", " ") ?? action;
}

function parseLinkedPage(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : null;
}

function parseLinkedPanel(
  value: string | null,
): "pdf" | "semantic" | "split" | null {
  return value === "pdf" || value === "semantic" || value === "split"
    ? value
    : null;
}
