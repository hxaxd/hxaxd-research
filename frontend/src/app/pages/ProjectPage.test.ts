import { describe, expect, it } from "vitest";

import type { CandidateDecision, ProjectItem } from "../../shared/api/contracts";
import { candidateDecisionTarget } from "./ProjectPage";

const included: CandidateDecision = { candidate_id: "candidate-1", decision: "include" };
const projectItem = { preferred_item_id: "item-1" } as ProjectItem;

describe("candidateDecisionTarget", () => {
  it("opens the included literature item returned by the backend", () => {
    expect(candidateDecisionTarget("project-1", included, { project_item: projectItem }))
      .toBe("/projects/project-1/items/item-1");
  });

  it("keeps exclusions in the inbox so the next candidate can be selected", () => {
    expect(candidateDecisionTarget(
      "project-1",
      { candidate_id: "candidate-1", decision: "exclude" },
      { project_item: projectItem },
    )).toBeNull();
  });
});
