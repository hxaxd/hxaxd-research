import { describe, expect, it } from "vitest";

import type { Resource, ResourceRepresentation } from "../../shared/api/contracts";
import { firstAvailableRepresentation, pdfByRepresentation } from "./artifactVariants";

function resource(representation: ResourceRepresentation, preferred = true): Resource {
  return {
    id: representation, paper_id: "paper", format: "pdf", representation,
    origin: "user", source_url: null, filename: `${representation}.pdf`,
    media_type: "application/pdf", sha256: representation, size: 10, preferred,
    parent_resource_id: null, job_id: null, created_at: "2026-01-01T00:00:00Z",
  };
}

describe("resource variants", () => {
  it("prefers the original PDF regardless of response order", () => {
    expect(firstAvailableRepresentation([resource("translated"), resource("original")])).toBe("original");
  });
  it("indexes each representation", () => {
    expect(pdfByRepresentation([resource("bilingual")]).bilingual?.filename).toBe("bilingual.pdf");
  });
});
