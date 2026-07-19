import type { Artifact, ArtifactKind } from "../../shared/api/contracts";

export const artifactLabels: Record<ArtifactKind, string> = {
  original: "原文",
  bilingual: "双语",
  chinese: "中文",
};

export const artifactOrder: ArtifactKind[] = ["original", "bilingual", "chinese"];

export function artifactsByKind(artifacts: Artifact[]): Partial<Record<ArtifactKind, Artifact>> {
  return Object.fromEntries(artifacts.map((artifact) => [artifact.kind, artifact]));
}

export function firstAvailableKind(artifacts: Artifact[]): ArtifactKind | null {
  const available = artifactsByKind(artifacts);
  return artifactOrder.find((kind) => available[kind] !== undefined) ?? null;
}

