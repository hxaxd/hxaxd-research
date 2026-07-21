import { describe, expect, it } from "vitest";

import type { DocumentBlock } from "../../shared/api/contracts";
import {
  calculateScrollProgress,
  effectiveReadingMode,
  filterSemanticBlocks,
  searchSemanticBlocks,
} from "./semanticReading";

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

  it("normalizes persisted scroll progress at document boundaries", () => {
    expect(calculateScrollProgress(250, 1000, 500)).toBe(0.5);
    expect(calculateScrollProgress(-20, 1000, 500)).toBe(0);
    expect(calculateScrollProgress(900, 1000, 500)).toBe(1);
    expect(calculateScrollProgress(0, 400, 500)).toBe(1);
  });

  it("searches source, translation, and section context without changing block order", () => {
    const blocks = [block("1", "background"), block("2", "method")];
    blocks[0]!.source_text = "Working memory background";
    blocks[1]!.section_path = ["Experimental method"];
    blocks[1]!.translation = {
      id: "translation-2",
      block_id: "2",
      target_language: "zh-CN",
      translated_text: "稳定段落",
      source_sha256: "2".padEnd(64, "0"),
      provider: "fixture",
      model: "fixture",
      prompt_version: "v1",
      batch_id: "batch-1",
      validation_status: "valid",
      created_by_job_id: null,
      created_at: "2026-07-22T00:00:00Z",
    };
    expect(searchSemanticBlocks(blocks, "MEMORY").map((item) => item.id)).toEqual(["1"]);
    expect(searchSemanticBlocks(blocks, "实验")).toEqual([]);
    expect(searchSemanticBlocks(blocks, "稳定").map((item) => item.id)).toEqual(["2"]);
    expect(searchSemanticBlocks(blocks, " method ").map((item) => item.id)).toEqual(["2"]);
  });
});
