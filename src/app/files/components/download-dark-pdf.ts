import type { PDFDocumentProxy } from 'pdfjs-dist';

const inversion = 0.9;
export const pdfDarkFilter = `invert(${inversion}) hue-rotate(180deg)`;

function applyDarkColors(context: CanvasRenderingContext2D) {
  const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  const data = pixels.data;
  const offset = inversion * 255;
  const factor = 1 - 2 * inversion;
  for (let index = 0; index < data.length; index += 4) {
    const red = offset + factor * data[index];
    const green = offset + factor * data[index + 1];
    const blue = offset + factor * data[index + 2];
    // A 180-degree CSS hue rotation reflects each channel around luma in sRGB.
    const twiceLuma = 2 * (0.213 * red + 0.715 * green + 0.072 * blue);
    data[index] = twiceLuma - red;
    data[index + 1] = twiceLuma - green;
    data[index + 2] = twiceLuma - blue;
  }
  context.putImageData(pixels, 0, 0);
}

export async function downloadDarkPdf(source: PDFDocumentProxy, name: string, signal: AbortSignal) {
  const { PDFDocument } = await import('pdf-lib');
  const output = await PDFDocument.create();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) throw new Error('Cannot create PDF export canvas');

  try {
    for (let index = 1; index <= source.numPages; index++) {
      signal.throwIfAborted();
      const page = await source.getPage(index);
      signal.throwIfAborted();
      const { width, height } = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 3072 / Math.max(width, height)) });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const render = page.render({ canvas, canvasContext: context, viewport, background: '#fff' });
      const cancel = () => render.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try { await render.promise; }
      finally {
        signal.removeEventListener('abort', cancel);
        page.cleanup();
      }
      signal.throwIfAborted();
      applyDarkColors(context);
      const image = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Cannot encode PDF page')), 'image/png');
      });
      const embedded = await output.embedPng(await image.arrayBuffer());
      await embedded.embed();
      output.addPage([width, height]).drawImage(embedded, { x: 0, y: 0, width, height });
    }
  } finally {
    canvas.width = canvas.height = 0;
  }

  signal.throwIfAborted();
  const bytes = await output.save();
  signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/\.pdf$/i, '')}-dark.pdf`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
