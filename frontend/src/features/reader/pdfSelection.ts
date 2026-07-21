export interface ScreenRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PdfSelectionAnchor {
  type: "pdf_text_selection";
  coordinate_system: "pdf-bottom-left";
  bbox: { x: number; y: number; x2: number; y2: number };
  rectangles: Array<{ x: number; y: number; x2: number; y2: number }>;
}

export function pdfSelectionAnchor(
  selectionRects: ScreenRectangle[],
  pageRect: ScreenRectangle,
  convertToPdfPoint: (x: number, y: number) => [number, number],
): PdfSelectionAnchor | null {
  const rectangles = selectionRects
    .map((rectangle) => intersect(rectangle, pageRect))
    .filter((rectangle): rectangle is ScreenRectangle => rectangle !== null)
    .map((rectangle) => {
      const first = convertToPdfPoint(
        rectangle.left - pageRect.left,
        rectangle.top - pageRect.top,
      );
      const second = convertToPdfPoint(
        rectangle.right - pageRect.left,
        rectangle.bottom - pageRect.top,
      );
      return {
        x: Math.min(first[0], second[0]),
        y: Math.min(first[1], second[1]),
        x2: Math.max(first[0], second[0]),
        y2: Math.max(first[1], second[1]),
      };
    })
    .filter((rectangle) => rectangle.x2 > rectangle.x && rectangle.y2 > rectangle.y);
  if (!rectangles.length) return null;
  return {
    type: "pdf_text_selection",
    coordinate_system: "pdf-bottom-left",
    bbox: {
      x: Math.min(...rectangles.map((rectangle) => rectangle.x)),
      y: Math.min(...rectangles.map((rectangle) => rectangle.y)),
      x2: Math.max(...rectangles.map((rectangle) => rectangle.x2)),
      y2: Math.max(...rectangles.map((rectangle) => rectangle.y2)),
    },
    rectangles,
  };
}

function intersect(
  rectangle: ScreenRectangle,
  container: ScreenRectangle,
): ScreenRectangle | null {
  const result = {
    left: Math.max(rectangle.left, container.left),
    top: Math.max(rectangle.top, container.top),
    right: Math.min(rectangle.right, container.right),
    bottom: Math.min(rectangle.bottom, container.bottom),
  };
  return result.right > result.left && result.bottom > result.top ? result : null;
}
