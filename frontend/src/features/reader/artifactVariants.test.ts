import { describe, expect, it } from "vitest";

import type { Artifact } from "../../shared/api/contracts";
import { artifactsByKind, firstAvailableKind } from "./artifactVariants";

function artifact(kind: Artifact["kind"]): Artifact {
  return {
    id: kind,
    paper_id: "paper",
    kind,
    filename: `${kind}.pdf`,
    relative_path: `${kind}.pdf`,
    sha256: kind,
    size: 10,
    created_at: "2026-01-01T00:00:00Z",
  };
}

describe("artifact variants", () => {
  it("prefers the original PDF regardless of response order", () => {
    expect(firstAvailableKind([artifact("chinese"), artifact("original")])).toBe("original");
  });

  it("indexes each variant by its stable kind", () => {
    expect(artifactsByKind([artifact("bilingual")]).bilingual?.filename).toBe("bilingual.pdf");
  });
});

