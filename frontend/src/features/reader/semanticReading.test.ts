import { describe, expect, it } from "vitest";

import type { DocumentBlock } from "../../shared/api/contracts";
import { effectiveReadingMode, filterSemanticBlocks } from "./semanticReading";

function block(id: string, role: DocumentBlock["semantic_role"]): DocumentBlock {
  return {
    id,
    document_id: "document-1",
    parent_id: null,
    ordinal: Number(id),
    kind: "paragraph",
    semantic_role: role,
    source_text: `block ${id}`,
    source_sha256: id.padEnd(64, "0"),
    page_start: 1,
    page_end: 1,
    anchor: {},
    section_path: [],
    created_at: "2026-07-22T00:00:00Z",
    translation: null,
  };
}

describe("semantic reading projection", () => {
  it("keeps source readable until a translation exists", () => {
    expect(effectiveReadingMode("bilingual", 0)).toBe("source");
    expect(effectiveReadingMode("translation", 3)).toBe("translation");
  });

  it("filters only blocks with the selected semantic role", () => {
    const blocks = [block("1", "background"), block("2", "method"), block("3", null)];
    expect(filterSemanticBlocks(blocks, "method").map((item) => item.id)).toEqual(["2"]);
    expect(filterSemanticBlocks(blocks, "all")).toEqual(blocks);
  });
});
