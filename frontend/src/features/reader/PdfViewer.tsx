import { useEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { EventBus, PDFFindController, PDFLinkService, PDFViewer as PdfJsViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";

import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import { Icon } from "../../shared/ui/Icon";
import "./reader.css";

GlobalWorkerOptions.workerSrc = workerUrl;
export type PdfColorMode = "normal" | "dark" | "sepia";

export function PdfViewer({ url, colorMode }: { url: string; colorMode: PdfColorMode }) {
  const container = useRef<HTMLDivElement>(null);
  const viewerElement = useRef<HTMLDivElement>(null);
  const viewer = useRef<PdfJsViewer | null>(null);
  const eventBus = useRef<EventBus | null>(null);
  const finder = useRef<PDFFindController | null>(null);
  const linkService = useRef<PDFLinkService | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState("page-width");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!container.current || !viewerElement.current) return;
    const bus = new EventBus();
    const links = new PDFLinkService({ eventBus: bus });
    const search = new PDFFindController({ eventBus: bus, linkService: links });
    const instance = new PdfJsViewer({
      container: container.current, viewer: viewerElement.current, eventBus: bus,
      linkService: links, findController: search, textLayerMode: 1,
    });
    links.setViewer(instance);
    bus.on("pagechanging", ({ pageNumber: nextPage }: { pageNumber: number }) => setPageNumber(nextPage));
    eventBus.current = bus; finder.current = search; linkService.current = links;
    viewer.current = instance;
    return () => {
      viewer.current = null; eventBus.current = null; finder.current = null;
      linkService.current = null;
    };
  }, []);

  useEffect(() => {
    const task = getDocument({ url });
    let active = true;
    setLoading(true); setError(null); setDocument(null); setPageNumber(1);
    void task.promise.then((nextDocument) => {
      if (!active || !viewer.current) return;
      setDocument(nextDocument); linkService.current?.setDocument(nextDocument);
      finder.current?.setDocument(nextDocument);
      viewer.current.setDocument(nextDocument);
      viewer.current.currentScaleValue = "page-width"; setScale("page-width");
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "PDF 加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      linkService.current?.setDocument(null as unknown as PDFDocumentProxy);
      finder.current?.setDocument(null as unknown as PDFDocumentProxy);
      viewer.current?.setDocument(null as unknown as PDFDocumentProxy);
      void task.destroy();
    };
  }, [url]);

  function setScaleValue(value: string) {
    if (!viewer.current) return;
    viewer.current.currentScaleValue = value; setScale(value);
  }
  function find(findPrevious = false, queryOverride?: string) {
    eventBus.current?.dispatch("find", {
      source: window, type: "", query: queryOverride ?? query,
      phraseSearch: true, caseSensitive: false,
      entireWord: false, highlightAll: true, findPrevious, matchDiacritics: false,
    });
  }

  return <div className={`pdf-viewer pdf-viewer--${colorMode}`}>
    <div className="pdf-findbar"><label><Icon name="search" size={14} /><input aria-label="在 PDF 中搜索" placeholder="在文中搜索" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") find(event.shiftKey, event.currentTarget.value); }} /></label><button type="button" title="上一个" onClick={() => find(true)}><Icon name="arrow-left" size={14} /></button><button type="button" title="下一个" onClick={() => find(false)}><Icon name="arrow-right" size={14} /></button></div>
    {loading ? <AsyncMessage kind="loading">正在载入 PDF…</AsyncMessage> : null}
    {error ? <AsyncMessage kind="error">{error}</AsyncMessage> : null}
    <div ref={container} className="pdf-scroll-container"><div ref={viewerElement} className="pdfViewer" /></div>
    {document ? <div className="pdf-page-controls"><button aria-label="上一页" type="button" disabled={pageNumber <= 1} onClick={() => { if (viewer.current) viewer.current.currentPageNumber = pageNumber - 1; }}><Icon name="arrow-left" size={16} /></button><label className="page-number-control"><input aria-label="当前页码" max={document.numPages} min={1} type="number" value={pageNumber} onChange={(event) => { if (viewer.current) viewer.current.currentPageNumber = Number(event.target.value); }} /><span>/ {document.numPages}</span></label><button aria-label="下一页" type="button" disabled={pageNumber >= document.numPages} onClick={() => { if (viewer.current) viewer.current.currentPageNumber = pageNumber + 1; }}><Icon name="arrow-right" size={16} /></button><span className="control-separator" /><button type="button" onClick={() => setScaleValue("page-width")}>适宽</button><button type="button" onClick={() => setScaleValue("page-fit")}>适页</button><select aria-label="缩放" value={scale} onChange={(event) => setScaleValue(event.target.value)}><option value="page-width">适宽</option><option value="page-fit">适页</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select></div> : null}
  </div>;
}
