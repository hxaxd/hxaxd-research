import type { DocumentBlock, SemanticRole } from "../../shared/api/contracts";

export type ReadingMode = "source" | "bilingual" | "translation";

export function effectiveReadingMode(
  requested: ReadingMode,
  translatedCount: number,
): ReadingMode {
  return translatedCount > 0 ? requested : "source";
}

export function filterSemanticBlocks(
  blocks: DocumentBlock[],
  role: SemanticRole | "all",
): DocumentBlock[] {
  return role === "all" ? blocks : blocks.filter((block) => block.semantic_role === role);
}
