import { describe, expect, it } from "vitest";

import { clampSplitRatio, splitRatioFromPointer } from "./SplitReader";

describe("split reader sizing", () => {
  it("maps touch position to a bounded split ratio", () => {
    expect(splitRatioFromPointer(400, 100, 600)).toBe(50);
    expect(splitRatioFromPointer(100, 100, 600)).toBe(30);
    expect(splitRatioFromPointer(700, 100, 600)).toBe(70);
  });

  it("keeps keyboard adjustments inside a usable tablet range", () => {
    expect(clampSplitRatio(25)).toBe(30);
    expect(clampSplitRatio(55.4)).toBe(55);
    expect(clampSplitRatio(82)).toBe(70);
  });
});
