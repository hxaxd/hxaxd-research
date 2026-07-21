import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { firstReadableAttachment } from "../../features/reader/artifactVariants";
import { PdfViewer, type PdfColorMode, type PdfTextSelection } from "../../features/reader/PdfViewer";
import { ReaderToolbar } from "../../features/reader/ReaderToolbar";
import { SemanticReader } from "../../features/reader/SemanticReader";
import { SplitReader } from "../../features/reader/SplitReader";
import { ProjectInsightEditor } from "../../features/projects/ProjectInsightEditor";
import { ResourceActions } from "../../features/resources/ResourceActions";
import { api } from "../../shared/api/client";
import type { AnnotationKind, Attachment } from "../../shared/api/contracts";
import { useApiResource } from "../../shared/api/useApiResource";
import { formatBytes } from "../../shared/lib/format";
import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import { Icon } from "../../shared/ui/Icon";
import "./pages.css";

const compactReaderQuery = "(max-width: 1180px)";

export function ItemPage() {
  const { projectId, itemId, attachmentId } = useParams<{ projectId: string; itemId: string; attachmentId?: string }>();
  const navigate = useNavigate();
  const workspace = useRef<HTMLDivElement>(null);
  const [colorMode, setColorMode] = useState<PdfColorMode>("normal");
  const [readerMode, setReaderMode] = useState<"pdf" | "semantic" | "split">("pdf");
  const preferencesApplied = useRef(false);
  const [requestedPage, setRequestedPage] = useState<number | null>(null);
  const [annotationRefreshToken, setAnnotationRefreshToken] = useState(0);
  const [inspectorOpen, setInspectorOpen] = useState(
    () => !window.matchMedia(compactReaderQuery).matches,
  );
  const resource = useApiResource(
    () => itemId && projectId ? Promise.all([api.item(itemId), api.attachments(itemId), api.userPreferences(), api.projectItems(projectId, "all")]) : Promise.reject(new Error("文献地址无效")),
    [itemId, projectId],
  );
  const selected = useMemo(() => {
    const attachments = resource.data?.[1] ?? [];
    return attachments.find((item) => item.id === attachmentId) ?? firstReadableAttachment(attachments);
  }, [attachmentId, resource.data]);

  useEffect(() => {
    if (!projectId || !itemId || !selected || attachmentId === selected.id) return;
    navigate(`/projects/${projectId}/items/${itemId}/read/${selected.id}`, { replace: true });
  }, [attachmentId, itemId, navigate, projectId, selected]);

  useEffect(() => {
    const preferences = resource.data?.[2];
    if (!preferences || preferencesApplied.current) return;
    preferencesApplied.current = true;
    setReaderMode(preferences.reader.default_panel === "structured" ? "semantic" : preferences.reader.default_panel);
    setColorMode(preferences.pdf.color_mode === "original" ? "normal" : preferences.pdf.color_mode);
  }, [resource.data]);

  useEffect(() => {
    const media = window.matchMedia(compactReaderQuery);
    const closeInspectorAtCompactWidths = () => {
      if (media.matches) setInspectorOpen(false);
    };
    media.addEventListener("change", closeInspectorAtCompactWidths);
    return () => media.removeEventListener("change", closeInspectorAtCompactWidths);
  }, []);

  if (resource.loading) return <AsyncMessage kind="loading">正在打开文献…</AsyncMessage>;
  if (resource.error) return <AsyncMessage kind="error" onRetry={() => void resource.retry()}>{resource.error}</AsyncMessage>;
  if (!projectId || !itemId || !resource.data) return <AsyncMessage kind="empty">文献不存在</AsyncMessage>;
  const [item, attachments, preferences, projectItems] = resource.data;
  const projectItem = projectItems.find((entry) => entry.work_id === item.work_id) ?? null;
  const creatorLine = item.creators.map((creator) => creator.literal_name || [creator.given_name, creator.family_name].filter(Boolean).join(" ") || creator.raw_name).join("、");

  function choose(attachment: Attachment) {
    navigate(`/projects/${projectId}/items/${itemId}/read/${attachment.id}`);
  }

  async function annotatePdf(selection: PdfTextSelection, kind: AnnotationKind) {
    if (!projectId || !itemId || !selected) throw new Error("没有可用于批注的 PDF 附件");
    await api.createAnnotation(projectId, itemId, {
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
    setAnnotationRefreshToken((value) => value + 1);
  }

  const pdf = selected ? <PdfViewer key={`${selected.id}-${selected.sha256}`} url={api.attachmentUrl(selected.id, selected.sha256)} colorMode={colorMode} initialPage={requestedPage} initialZoom={preferences.pdf.default_zoom === "page_width" ? "page-width" : preferences.pdf.default_zoom === "page_fit" ? "page-fit" : "auto"} toolbarDensity={preferences.pdf.toolbar_density} onAnnotateSelection={annotatePdf} /> : null;
  const semantic = selected ? <SemanticReader projectId={projectId} itemId={itemId} attachment={selected} annotationRefreshToken={annotationRefreshToken} onOpenPdf={(page) => { setRequestedPage(page); setReaderMode("pdf"); }} /> : null;
  return <section className="item-page" ref={workspace}><header className="item-header"><Link className="paper-back-link" to={`/projects/${projectId}?tab=library`} title="返回项目"><Icon name="arrow-left" size={18} /></Link><div><span>{item.item_type} · {item.issued_year ?? "年份未知"} · {creatorLine || "作者未知"}</span><h1>{item.translated_title || item.title}</h1>{item.translated_title ? <p>{item.title}</p> : null}</div><button className={inspectorOpen ? "toolbar-button active" : "toolbar-button"} type="button" onClick={() => setInspectorOpen((value) => !value)}><Icon name="panel-left" size={15} />信息</button></header><div className={inspectorOpen ? "reading-workspace" : "reading-workspace reading-workspace--wide"}><div className="reader-frame"><ReaderToolbar attachments={attachments} selected={selected?.language_mode ?? null} colorMode={colorMode} readerMode={readerMode} onReaderMode={setReaderMode} onSelect={choose} onColorMode={setColorMode} onFullscreen={() => void workspace.current?.requestFullscreen()} actions={selected ? <a className="toolbar-button" href={api.attachmentDownloadUrl(selected.id)}><Icon name="download" size={15} /><span>下载</span></a> : null} />{selected ? readerMode === "split" ? <SplitReader pdf={pdf} semantic={semantic} /> : readerMode === "semantic" ? semantic : pdf : <div className="reader-empty"><Icon name="file-text" size={26} /><h2>尚无可阅读的 PDF</h2><p>可以在右侧上传、获取或编译资源。</p></div>}</div>{inspectorOpen ? <aside className="item-inspector"><section><span className="eyebrow">BIBLIOGRAPHY</span><h2>书目信息</h2><dl><dt>作者</dt><dd>{creatorLine || "未知"}{!item.creator_list_complete ? "（作者列表不完整）" : ""}</dd><dt>发表</dt><dd>{item.container_title || item.publisher || "未知来源"} · {item.issued_literal || item.issued_year || "日期未知"}</dd><dt>摘要</dt><dd>{item.abstract || "尚未收录摘要"}</dd><dt>标识符</dt><dd>{item.identifiers.map((identifier) => <code key={identifier.id}>{identifier.scheme}:{identifier.value}</code>)}</dd></dl></section>{projectItem ? <ProjectInsightEditor projectId={projectId} initial={projectItem} /> : null}<ResourceActions itemId={itemId} attachments={attachments} onAttachmentChanged={resource.reload} /><section><h2>附件</h2><div className="attachment-list">{attachments.map((attachment) => <button className={attachment.id === selected?.id ? "active" : ""} key={attachment.id} type="button" onClick={() => attachment.format === "pdf" && choose(attachment)}><Icon name={attachment.format === "pdf" ? "file-text" : "terminal"} size={15} /><span><strong>{attachment.filename}</strong><small>{attachment.language_mode} · {formatBytes(attachment.size)} · {attachment.origin}</small></span></button>)}</div></section><section><h2>来源链接</h2>{item.links.length ? item.links.map((link) => <a className="source-link" href={link.url} key={link.id} target="_blank" rel="noreferrer"><Icon name="external-link" size={14} />{link.title || link.relation_type}</a>) : <p>暂无来源链接。</p>}</section></aside> : null}</div></section>;
}
