import { describe, expect, it } from "vitest";

import type { Candidate } from "../../shared/api/contracts";
import { candidateDifferences, nextCandidateId } from "./CandidateInbox";

function candidate(id: string): Candidate {
  return {
    id,
    item: {
      item_type: "journalArticle",
      title: "Semantic Reading",
      issued_year: 2026,
      container_title: "New Journal",
      creators: [{ role: "author", creator_type: "literal", literal_name: "Ada", raw_name: "Ada" }],
      identifiers: [{ scheme: "doi", value: "10.1/example", is_primary: true }],
    },
    matched_item: {
      title: "Semantic Reading",
      issued_year: 2025,
      container_title: "Old Journal",
      creators: [{ literal_name: "Ada", given_name: null, family_name: null, raw_name: "Ada" }],
      identifiers: [{ scheme: "doi", value: "10.1/example" }],
    },
  } as Candidate;
}

describe("candidate review helpers", () => {
  it("shows concrete matching-field differences instead of only a duplicate badge", () => {
    const rows = candidateDifferences(candidate("one"));

    expect(rows.find((row) => row.label === "标题")?.equal).toBe(true);
    expect(rows.find((row) => row.label === "年份")).toMatchObject({
      proposed: "2026",
      existing: "2025",
      equal: false,
    });
    expect(rows.find((row) => row.label === "出版来源")?.equal).toBe(false);
    expect(rows.find((row) => row.label === "标识符")?.equal).toBe(true);
  });

  it("moves keyboard selection within the candidate list boundaries", () => {
    const items = [candidate("one"), candidate("two"), candidate("three")];

    expect(nextCandidateId(items, "one", 1)).toBe("two");
    expect(nextCandidateId(items, "two", -1)).toBe("one");
    expect(nextCandidateId(items, "three", 1)).toBe("three");
    expect(nextCandidateId(items, "one", -1)).toBe("one");
  });
});
