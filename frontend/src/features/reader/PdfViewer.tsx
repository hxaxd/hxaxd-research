import { useCallback, useEffect, useRef, useState } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer as PdfJsViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";

import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import type { Annotation, AnnotationKind } from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";
import { pdfSelectionAnchor, type PdfSelectionAnchor } from "./pdfSelection";
import "./reader.css";

// Keep the module request distinct from any pre-fix service-worker cache entry
// that may have stored the same content hash with a non-module MIME type.
GlobalWorkerOptions.workerSrc = `${workerUrl}?module=1`;
export type PdfColorMode = "normal" | "dark" | "sepia";

export interface PdfTextSelection {
  text: string;
  pageNumber: number;
  anchor: PdfSelectionAnchor;
}

interface PdfSelectionMenu {
  selection: PdfTextSelection;
  left: number;
  top: number;
}

interface PdfViewerProps {
  url: string;
  colorMode: PdfColorMode;
  initialPage?: number | null;
  initialZoom?: "auto" | "page-width" | "page-fit";
  toolbarDensity?: "compact" | "comfortable";
  annotations?: Annotation[];
  onAnnotateSelection?: (
    selection: PdfTextSelection,
    kind: AnnotationKind,
  ) => Promise<void>;
  onDeleteAnnotation?: (annotation: Annotation) => Promise<void>;
  onPageChange?: (pageNumber: number, pageCount: number) => void;
}

export function PdfViewer({
  url,
  colorMode,
  initialPage,
  initialZoom = "page-width",
  toolbarDensity = "comfortable",
  annotations = [],
  onAnnotateSelection,
  onDeleteAnnotation,
  onPageChange,
}: PdfViewerProps) {
  const root = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const viewerElement = useRef<HTMLDivElement>(null);
  const viewer = useRef<PdfJsViewer | null>(null);
  const eventBus = useRef<EventBus | null>(null);
  const finder = useRef<PDFFindController | null>(null);
  const linkService = useRef<PDFLinkService | null>(null);
  const annotationsRef = useRef(annotations);
  const onPageChangeRef = useRef(onPageChange);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState<string>(
    initialZoom === "auto" ? "page-width" : initialZoom,
  );
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<PdfSelectionMenu | null>(
    null,
  );
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [annotationBusyId, setAnnotationBusyId] = useState<string | null>(null);
  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  annotationsRef.current = annotations;
  onPageChangeRef.current = onPageChange;

  const renderAnnotationLayers = useCallback(() => {
    const rootElement = root.current;
    const viewerInstance = viewer.current;
    if (!rootElement || !viewerInstance) return;
    rootElement
      .querySelectorAll(".pdf-annotation-layer")
      .forEach((node) => node.remove());
    for (const annotation of annotationsRef.current) {
      if (annotation.anchor_status !== "valid" || !annotation.page_number)
        continue;
      const anchor = readPdfAnchor(annotation.anchor);
      if (!anchor) continue;
      const pageElement = rootElement.querySelector<HTMLElement>(
        `.pdfViewer .page[data-page-number="${annotation.page_number}"]`,
      );
      const pageView = viewerInstance.getPageView(annotation.page_number - 1);
      if (!pageElement || !pageView?.viewport) continue;
      let layer = pageElement.querySelector<HTMLElement>(
        ".pdf-annotation-layer",
      );
      if (!layer) {
        layer = globalThis.document.createElement("div");
        layer.className = "pdf-annotation-layer";
        layer.setAttribute("aria-hidden", "true");
        pageElement.append(layer);
      }
      for (const rectangle of anchor.rectangles) {
        const viewportRectangle = pageView.viewport.convertToViewportRectangle([
          rectangle.x,
          rectangle.y,
          rectangle.x2,
          rectangle.y2,
        ]);
        const left = Math.min(viewportRectangle[0], viewportRectangle[2]);
        const top = Math.min(viewportRectangle[1], viewportRectangle[3]);
        const marker = globalThis.document.createElement("span");
        marker.className = `pdf-annotation-mark pdf-annotation-mark--${annotation.kind}`;
        marker.title = annotation.body || annotation.quoted_text || "PDF 批注";
        Object.assign(marker.style, {
          left: `${left}px`,
          top: `${top}px`,
          width: `${Math.abs(viewportRectangle[2] - viewportRectangle[0])}px`,
          height: `${Math.abs(viewportRectangle[3] - viewportRectangle[1])}px`,
        });
        layer.append(marker);
      }
    }
  }, []);

  useEffect(() => {
    if (!container.current || !viewerElement.current) return;
    const bus = new EventBus();
    const links = new PDFLinkService({ eventBus: bus });
    const search = new PDFFindController({ eventBus: bus, linkService: links });
    const instance = new PdfJsViewer({
      container: container.current,
      viewer: viewerElement.current,
      eventBus: bus,
      linkService: links,
      findController: search,
      textLayerMode: 1,
    });
    links.setViewer(instance);
    const onPageChanging = ({
      pageNumber: nextPage,
    }: {
      pageNumber: number;
    }) => {
      setPageNumber(nextPage);
      onPageChangeRef.current?.(
        nextPage,
        viewer.current?.pagesCount ?? nextPage,
      );
      window.requestAnimationFrame(renderAnnotationLayers);
    };
    const redrawAnnotations = () =>
      window.requestAnimationFrame(renderAnnotationLayers);
    bus.on("pagechanging", onPageChanging);
    bus.on("pagerendered", redrawAnnotations);
    bus.on("scalechanging", redrawAnnotations);
    bus.on("rotationchanging", redrawAnnotations);
    eventBus.current = bus;
    finder.current = search;
    linkService.current = links;
    viewer.current = instance;
    return () => {
      bus.off("pagechanging", onPageChanging);
      bus.off("pagerendered", redrawAnnotations);
      bus.off("scalechanging", redrawAnnotations);
      bus.off("rotationchanging", redrawAnnotations);
      viewer.current = null;
      eventBus.current = null;
      finder.current = null;
      linkService.current = null;
    };
  }, [renderAnnotationLayers]);

  useEffect(() => {
    const task = getDocument({ url });
    let active = true;
    setLoading(true);
    setError(null);
    setDocument(null);
    setPageNumber(1);
    void task.promise
      .then((nextDocument) => {
        if (!active || !viewer.current) return;
        setDocument(nextDocument);
        linkService.current?.setDocument(nextDocument);
        finder.current?.setDocument(nextDocument);
        viewer.current.setDocument(nextDocument);
        const zoom = initialZoom === "auto" ? "page-width" : initialZoom;
        viewer.current.currentScaleValue = zoom;
        setScale(zoom);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(reason instanceof Error ? reason.message : "PDF 加载失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      linkService.current?.setDocument(null as unknown as PDFDocumentProxy);
      finder.current?.setDocument(null as unknown as PDFDocumentProxy);
      viewer.current?.setDocument(null as unknown as PDFDocumentProxy);
      void task.destroy();
    };
  }, [initialZoom, loadAttempt, url]);

  useEffect(() => {
    if (!document || !viewer.current || !initialPage) return;
    const target = Math.min(document.numPages, Math.max(1, initialPage));
    const bus = eventBus.current;
    const restore = () => {
      const instance = viewer.current;
      if (
        !instance ||
        instance.pagesCount < target ||
        !instance.getPageView(target - 1)
      )
        return;
      instance.currentPageNumber = target;
      bus?.off("pagesinit", restore);
      bus?.off("pagesloaded", restore);
    };
    bus?.on("pagesinit", restore);
    bus?.on("pagesloaded", restore);
    restore();
    return () => {
      bus?.off("pagesinit", restore);
      bus?.off("pagesloaded", restore);
    };
  }, [document, initialPage]);

  useEffect(() => {
    if (!document) return;
    const frame = window.requestAnimationFrame(renderAnnotationLayers);
    return () => window.cancelAnimationFrame(frame);
  }, [annotations, document, renderAnnotationLayers, scale]);

  const captureSelection = useCallback(() => {
    if (!root.current || !viewer.current || !onAnnotateSelection) return;
    const selected = window.getSelection();
    const text = selected?.toString().trim() ?? "";
    if (!selected || selected.isCollapsed || !text) {
      setSelectionMenu(null);
      return;
    }
    if (text.length > 50_000) {
      setSelectionMessage("选区过长，请缩小到 5 万字以内");
      setSelectionMenu(null);
      return;
    }
    const anchorPage = closestPage(selected.anchorNode);
    const focusPage = closestPage(selected.focusNode);
    if (
      !anchorPage ||
      !focusPage ||
      anchorPage !== focusPage ||
      !root.current.contains(anchorPage)
    ) {
      setSelectionMessage("请在同一页内选择文字后创建记录");
      setSelectionMenu(null);
      return;
    }
    const pageNumber = Number(anchorPage.dataset.pageNumber);
    const pageView = viewer.current.getPageView(pageNumber - 1);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || !pageView?.viewport)
      return;
    const range = selected.rangeCount ? selected.getRangeAt(0) : null;
    if (!range) return;
    const rects = Array.from(range.getClientRects()).map((rectangle) => ({
      left: rectangle.left,
      top: rectangle.top,
      right: rectangle.right,
      bottom: rectangle.bottom,
    }));
    const pageRectangle = anchorPage.getBoundingClientRect();
    const anchor = pdfSelectionAnchor(
      rects,
      pageRectangle,
      (x, y) => pageView.viewport.convertToPdfPoint(x, y) as [number, number],
    );
    if (!anchor) return;
    const selectionRectangle = range.getBoundingClientRect();
    const rootRectangle = root.current.getBoundingClientRect();
    setSelectionMessage(null);
    setSelectionMenu({
      selection: { text, pageNumber, anchor },
      left: Math.min(
        Math.max(
          selectionRectangle.left +
            selectionRectangle.width / 2 -
            rootRectangle.left,
          32,
        ),
        rootRectangle.width - 32,
      ),
      top: Math.min(
        Math.max(selectionRectangle.bottom - rootRectangle.top + 10, 56),
        rootRectangle.height - 68,
      ),
    });
  }, [onAnnotateSelection]);

  useEffect(() => {
    if (!onAnnotateSelection) return;
    let timer: number | undefined;
    const scheduleCapture = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(captureSelection, 120);
    };
    const scrollContainer = container.current;
    const dismiss = () => setSelectionMenu(null);
    globalThis.document.addEventListener("selectionchange", scheduleCapture);
    scrollContainer?.addEventListener("scroll", dismiss, { passive: true });
    return () => {
      window.clearTimeout(timer);
      globalThis.document.removeEventListener(
        "selectionchange",
        scheduleCapture,
      );
      scrollContainer?.removeEventListener("scroll", dismiss);
    };
  }, [captureSelection, onAnnotateSelection]);

  async function annotateSelection(kind: AnnotationKind) {
    if (!selectionMenu || !onAnnotateSelection) return;
    setSelectionBusy(true);
    setSelectionMessage(null);
    try {
      await onAnnotateSelection(selectionMenu.selection, kind);
      setSelectionMessage("阅读记录已保存");
      window.getSelection()?.removeAllRanges();
      setSelectionMenu(null);
    } catch (reason) {
      setSelectionMessage(
        reason instanceof Error ? reason.message : "阅读记录保存失败",
      );
    } finally {
      setSelectionBusy(false);
    }
  }

  async function deleteAnnotation(annotation: Annotation) {
    if (!onDeleteAnnotation) return;
    setAnnotationBusyId(annotation.id);
    setSelectionMessage(null);
    try {
      await onDeleteAnnotation(annotation);
      setSelectionMessage("批注已删除");
    } catch (reason) {
      setSelectionMessage(
        reason instanceof Error ? reason.message : "批注删除失败",
      );
    } finally {
      setAnnotationBusyId(null);
    }
  }

  function setScaleValue(value: string) {
    if (!viewer.current) return;
    viewer.current.currentScaleValue = value;
    setScale(value);
  }
  function find(findPrevious = false, queryOverride?: string) {
    eventBus.current?.dispatch("find", {
      source: window,
      type: "",
      query: queryOverride ?? query,
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false,
    });
  }

  return (
    <div
      ref={root}
      className={`pdf-viewer pdf-viewer--${colorMode} pdf-viewer--toolbar-${toolbarDensity}`}
      onPointerUp={() => window.setTimeout(captureSelection, 0)}
    >
      <div className="pdf-findbar">
        <label>
          <Icon name="search" size={14} />
          <input
            aria-label="在 PDF 中搜索"
            placeholder="在文中搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter")
                find(event.shiftKey, event.currentTarget.value);
            }}
          />
        </label>
        <button type="button" title="上一个" onClick={() => find(true)}>
          <Icon name="arrow-left" size={14} />
        </button>
        <button type="button" title="下一个" onClick={() => find(false)}>
          <Icon name="arrow-right" size={14} />
        </button>
        <button
          aria-label={`PDF 批注，共 ${annotations.length} 条`}
          aria-expanded={annotationsOpen}
          className={
            annotationsOpen
              ? "pdf-annotations-toggle active"
              : "pdf-annotations-toggle"
          }
          type="button"
          title={`PDF 批注，共 ${annotations.length} 条`}
          onClick={() => setAnnotationsOpen((value) => !value)}
        >
          <Icon name="note" size={14} />
          <span>批注 {annotations.length}</span>
        </button>
      </div>
      {loading ? (
        <AsyncMessage kind="loading">正在载入 PDF…</AsyncMessage>
      ) : null}
      {error ? (
        <AsyncMessage
          kind="error"
          retryLabel="重新载入 PDF"
          onRetry={() => setLoadAttempt((value) => value + 1)}
        >
          {error}
        </AsyncMessage>
      ) : null}
      <div ref={container} className="pdf-scroll-container">
        <div ref={viewerElement} className="pdfViewer" />
      </div>
      {annotationsOpen ? (
        <aside className="pdf-annotations-panel" aria-label="PDF 批注">
          <header>
            <div>
              <strong>本文批注</strong>
              <span>{annotations.length} 条</span>
            </div>
            <button
              aria-label="关闭 PDF 批注"
              type="button"
              onClick={() => setAnnotationsOpen(false)}
            >
              <Icon name="close" size={16} />
            </button>
          </header>
          {annotations.length ? (
            <div className="pdf-annotations-list">
              {annotations.map((annotation) => (
                <article key={annotation.id}>
                  <button
                    disabled={
                      !annotation.page_number ||
                      annotation.anchor_status !== "valid"
                    }
                    type="button"
                    onClick={() => {
                      if (viewer.current && annotation.page_number)
                        viewer.current.currentPageNumber =
                          annotation.page_number;
                    }}
                  >
                    <small>
                      {annotationLabels[annotation.kind]} ·{" "}
                      {annotation.page_number
                        ? `第 ${annotation.page_number} 页`
                        : "位置未知"}
                      {annotation.anchor_status !== "valid"
                        ? " · 锚点失效"
                        : ""}
                    </small>
                    <strong>
                      {annotation.body ||
                        annotation.quoted_text ||
                        "已标记内容"}
                    </strong>
                  </button>
                  {onDeleteAnnotation ? (
                    <button
                      aria-label="删除 PDF 批注"
                      disabled={annotationBusyId === annotation.id}
                      type="button"
                      onClick={() => void deleteAnnotation(annotation)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <p>在 PDF 中选择文字即可创建高亮、摘录或研究笔记。</p>
          )}
        </aside>
      ) : null}
      {selectionMenu ? (
        <div
          className="pdf-selection-actions"
          role="toolbar"
          aria-label="PDF 选区操作"
          style={{ left: selectionMenu.left, top: selectionMenu.top }}
        >
          {(
            [
              ["highlight", "高亮"],
              ["excerpt", "摘录"],
              ["question", "问题"],
              ["claim", "主张"],
              ["method", "方法"],
              ["result", "结果"],
              ["limitation", "局限"],
            ] as Array<[AnnotationKind, string]>
          ).map(([kind, label]) => (
            <button
              disabled={selectionBusy}
              key={kind}
              type="button"
              onClick={() => void annotateSelection(kind)}
            >
              <Icon name="note" size={14} />
              {label}
            </button>
          ))}
          <button
            aria-label="关闭选区操作"
            disabled={selectionBusy}
            type="button"
            onClick={() => setSelectionMenu(null)}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      ) : null}
      {selectionMessage ? (
        <div className="pdf-selection-message" role="status">
          {selectionMessage}
        </div>
      ) : null}
      {document ? (
        <div className="pdf-page-controls">
          <button
            aria-label="上一页"
            type="button"
            disabled={pageNumber <= 1}
            onClick={() => {
              if (viewer.current)
                viewer.current.currentPageNumber = pageNumber - 1;
            }}
          >
            <Icon name="arrow-left" size={16} />
          </button>
          <label className="page-number-control">
            <input
              aria-label="当前页码"
              max={document.numPages}
              min={1}
              type="number"
              value={pageNumber}
              onChange={(event) => {
                if (viewer.current)
                  viewer.current.currentPageNumber = Number(event.target.value);
              }}
            />
            <span>/ {document.numPages}</span>
          </label>
          <button
            aria-label="下一页"
            type="button"
            disabled={pageNumber >= document.numPages}
            onClick={() => {
              if (viewer.current)
                viewer.current.currentPageNumber = pageNumber + 1;
            }}
          >
            <Icon name="arrow-right" size={16} />
          </button>
          <span className="control-separator" />
          <button type="button" onClick={() => setScaleValue("page-width")}>
            适宽
          </button>
          <button type="button" onClick={() => setScaleValue("page-fit")}>
            适页
          </button>
          <select
            aria-label="缩放"
            value={scale}
            onChange={(event) => setScaleValue(event.target.value)}
          >
            <option value="page-width">适宽</option>
            <option value="page-fit">适页</option>
            <option value="0.75">75%</option>
            <option value="1">100%</option>
            <option value="1.25">125%</option>
            <option value="1.5">150%</option>
            <option value="2">200%</option>
          </select>
        </div>
      ) : null}
    </div>
  );
}

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

function readPdfAnchor(
  anchor: Annotation["anchor"],
): PdfSelectionAnchor | null {
  if (
    anchor.type !== "pdf_text_selection" ||
    anchor.coordinate_system !== "pdf-bottom-left"
  ) {
    return null;
  }
  const rectangles = Array.isArray(anchor.rectangles) ? anchor.rectangles : [];
  if (!rectangles.length) return null;
  const normalized = rectangles.flatMap((rectangle) => {
    if (!rectangle || typeof rectangle !== "object") return [];
    const values = rectangle as Record<string, unknown>;
    const result = [values.x, values.y, values.x2, values.y2];
    return result.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    )
      ? [
          {
            x: result[0] as number,
            y: result[1] as number,
            x2: result[2] as number,
            y2: result[3] as number,
          },
        ]
      : [];
  });
  const first = normalized[0];
  if (!first) return null;
  return {
    type: "pdf_text_selection",
    coordinate_system: "pdf-bottom-left",
    bbox: normalized.reduce(
      (box, rectangle) => ({
        x: Math.min(box.x, rectangle.x),
        y: Math.min(box.y, rectangle.y),
        x2: Math.max(box.x2, rectangle.x2),
        y2: Math.max(box.y2, rectangle.y2),
      }),
      { x: first.x, y: first.y, x2: first.x2, y2: first.y2 },
    ),
    rectangles: normalized,
  };
}

function closestPage(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return (
    element?.closest<HTMLElement>(".pdfViewer .page[data-page-number]") ?? null
  );
}
