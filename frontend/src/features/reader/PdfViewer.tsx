import { useEffect, useRef, useState } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { AsyncMessage } from "../../shared/ui/AsyncMessage";
import "./reader.css";

GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfColorMode = "normal" | "dark" | "sepia";

interface PdfViewerProps {
  url: string;
  colorMode: PdfColorMode;
}

export function PdfViewer({ url, colorMode }: PdfViewerProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1.25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const task = getDocument({ url });
    let active = true;
    setLoading(true);
    setError(null);
    setPageNumber(1);
    void task.promise
      .then((nextDocument) => {
        if (active) setDocument(nextDocument);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "PDF 加载失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      void task.destroy();
      setDocument(null);
    };
  }, [url]);

  useEffect(() => {
    if (!document || !canvas.current) return;
    let active = true;
    let renderTask: RenderTask | null = null;
    void document.getPage(pageNumber).then((page) => {
      if (!active || !canvas.current) return;
      const viewport = page.getViewport({ scale: zoom });
      const outputScale = window.devicePixelRatio || 1;
      const context = canvas.current.getContext("2d");
      if (!context) return;
      canvas.current.width = Math.floor(viewport.width * outputScale);
      canvas.current.height = Math.floor(viewport.height * outputScale);
      canvas.current.style.width = `${Math.floor(viewport.width)}px`;
      canvas.current.style.height = `${Math.floor(viewport.height)}px`;
      renderTask = page.render({
        canvas: canvas.current,
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      });
      void renderTask.promise.catch((reason: unknown) => {
        if (active && reason instanceof Error && reason.name !== "RenderingCancelledException") {
          setError(reason.message);
        }
      });
    });
    return () => {
      active = false;
      renderTask?.cancel();
    };
  }, [document, pageNumber, zoom]);

  if (loading) return <AsyncMessage kind="loading">正在载入 PDF…</AsyncMessage>;
  if (error) return <AsyncMessage kind="error">{error}</AsyncMessage>;
  if (!document) return <AsyncMessage kind="empty">没有可显示的 PDF</AsyncMessage>;

  return (
    <div className={`pdf-viewer pdf-viewer--${colorMode}`}>
      <div className="pdf-page-stage">
        <canvas ref={canvas} />
      </div>
      <div className="pdf-page-controls">
        <button
          type="button"
          disabled={pageNumber <= 1}
          onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
        >
          上一页
        </button>
        <span>
          {pageNumber} / {document.numPages}
        </span>
        <button
          type="button"
          disabled={pageNumber >= document.numPages}
          onClick={() => setPageNumber((current) => Math.min(document.numPages, current + 1))}
        >
          下一页
        </button>
        <span className="control-separator" />
        <button type="button" onClick={() => setZoom((current) => Math.max(0.6, current - 0.15))}>
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((current) => Math.min(3, current + 0.15))}>
          ＋
        </button>
      </div>
    </div>
  );
}
