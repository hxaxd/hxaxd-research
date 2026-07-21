import { describe, expect, it } from "vitest";

import type { Attachment } from "../../shared/api/contracts";
import { firstReadableAttachment, pdfByLanguageMode } from "./artifactVariants";

function attachment(id: string, mode: Attachment["language_mode"], preferred = false): Attachment {
  return {
    id,
    item_id: "item",
    attachment_type: "fulltext",
    format: "pdf",
    language_mode: mode,
    origin: "user",
    filename: `${id}.pdf`,
    media_type: "application/pdf",
    sha256: id.padEnd(64, "0"),
    size: 1,
    preferred_for: preferred ? ["reading"] : [],
    created_at: "2026-07-21T00:00:00Z",
  };
}

describe("attachment variants", () => {
  it("selects the preferred attachment for each language mode", () => {
    const variants = pdfByLanguageMode([
      attachment("old", "original"),
      attachment("preferred", "original", true),
      attachment("bi", "bilingual"),
    ]);
    expect(variants.original?.id).toBe("preferred");
    expect(variants.bilingual?.id).toBe("bi");
  });

  it("prefers original, then bilingual, then translated for initial reading", () => {
    expect(firstReadableAttachment([attachment("zh", "translated"), attachment("bi", "bilingual")])?.id).toBe("bi");
  });
});
