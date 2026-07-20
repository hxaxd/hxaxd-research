import type { Resource, ResourceRepresentation } from "../../shared/api/contracts";

export const resourceLabels: Record<ResourceRepresentation, string> = {
  original: "原文", bilingual: "双语", translated: "中文",
};
export const resourceOrder: ResourceRepresentation[] = ["original", "bilingual", "translated"];

export function pdfByRepresentation(resources: Resource[]): Partial<Record<ResourceRepresentation, Resource>> {
  const result: Partial<Record<ResourceRepresentation, Resource>> = {};
  for (const resource of resources.filter((item) => item.format === "pdf").toSorted((a, b) => Number(b.preferred) - Number(a.preferred))) {
    result[resource.representation] ??= resource;
  }
  return result;
}

export function firstAvailableRepresentation(resources: Resource[]): ResourceRepresentation | null {
  const available = pdfByRepresentation(resources);
  return resourceOrder.find((kind) => available[kind] !== undefined) ?? null;
}
