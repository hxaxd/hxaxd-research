import { describe, expect, it } from "vitest";

import type { Job, TaskPreferences } from "../../shared/api/contracts";
import { taskEffects } from "./taskEffects";

const preferences: TaskPreferences = {
  notify_on_success: true,
  notify_on_failure: false,
  auto_open_result: true,
  max_concurrent_jobs: 2,
};

function job(id: string, status: Job["status"]): Job {
  return {
    id,
    kind: "document.translate",
    subject_type: "document",
    subject_id: "document-1",
    status,
    priority: 0,
    result: null,
    error_code: null,
    error_message: null,
    max_attempts: 2,
    created_at: "2026-07-22T00:00:00Z",
    updated_at: "2026-07-22T00:01:00Z",
    started_at: "2026-07-22T00:00:10Z",
    finished_at: status === "running" ? null : "2026-07-22T00:01:00Z",
    cancel_requested_at: null,
  };
}

describe("taskEffects", () => {
  it("applies success notification and auto-open only on a real transition", () => {
    const effects = taskEffects(
      new Map([["done", "running"], ["already", "succeeded"]]),
      [job("done", "succeeded"), job("already", "succeeded")],
      preferences,
    );

    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ outcome: "succeeded", notify: true, autoOpen: true });
  });

  it("does not auto-open failures and respects their notification setting", () => {
    expect(taskEffects(
      new Map([["failed", "running"]]),
      [job("failed", "failed")],
      preferences,
    )[0]).toMatchObject({ outcome: "failed", notify: false, autoOpen: false });
  });
});
