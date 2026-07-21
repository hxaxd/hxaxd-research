import { describe, expect, it } from "vitest";

import { pdfSelectionAnchor } from "./pdfSelection";

describe("pdfSelectionAnchor", () => {
  it("clips screen rectangles and converts them to bottom-left PDF coordinates", () => {
    const anchor = pdfSelectionAnchor(
      [
        { left: 110, top: 220, right: 180, bottom: 240 },
        { left: 170, top: 238, right: 260, bottom: 258 },
        { left: 0, top: 0, right: 20, bottom: 20 },
      ],
      { left: 100, top: 200, right: 250, bottom: 400 },
      (x, y) => [x * 2, 400 - y * 2],
    );

    expect(anchor).toEqual({
      type: "pdf_text_selection",
      coordinate_system: "pdf-bottom-left",
      bbox: { x: 20, y: 284, x2: 300, y2: 360 },
      rectangles: [
        { x: 20, y: 320, x2: 160, y2: 360 },
        { x: 140, y: 284, x2: 300, y2: 324 },
      ],
    });
  });

  it("returns null when the selection is outside the page", () => {
    expect(pdfSelectionAnchor(
      [{ left: 0, top: 0, right: 10, bottom: 10 }],
      { left: 20, top: 20, right: 100, bottom: 100 },
      (x, y) => [x, y],
    )).toBeNull();
  });
});
