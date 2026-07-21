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

export function calculateScrollProgress(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const maximum = scrollHeight - clientHeight;
  if (maximum <= 0) return 1;
  return Math.min(1, Math.max(0, scrollTop / maximum));
}

export function searchSemanticBlocks(
  blocks: DocumentBlock[],
  query: string,
): DocumentBlock[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return blocks;
  return blocks.filter((block) => (
    block.source_text.toLocaleLowerCase().includes(normalized)
    || block.translation?.translated_text.toLocaleLowerCase().includes(normalized)
    || block.section_path.some((section) => section.toLocaleLowerCase().includes(normalized))
  ));
}
