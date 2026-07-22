import { describe, expect, it } from "vitest";

import type { AgentRun, ChangeSet, Job, JobEvent } from "../../shared/api/contracts";
import { defaultTaskKind, taskFailureGuidance } from "./TaskCenter";

const job: Job = {
  id: "job-1",
  kind: "document.translate",
  subject_type: "document",
  subject_id: "document-1",
  status: "failed",
  priority: 0,
  result: null,
  error_code: "provider_unavailable",
  error_message: "服务暂时不可用",
  max_attempts: 3,
  created_at: "2026-07-22T00:00:00Z",
  updated_at: "2026-07-22T00:01:00Z",
  started_at: "2026-07-22T00:00:01Z",
  finished_at: "2026-07-22T00:01:00Z",
  cancel_requested_at: null,
};

function failureEvent(retryable: boolean): JobEvent {
  return {
    id: 5,
    job_id: job.id,
    event_type: "job.failed",
    level: "error",
    payload: { code: job.error_code, retryable },
    created_at: job.finished_at!,
  };
}

describe("task failure guidance", () => {
  it("distinguishes an exhausted transient failure from invalid input", () => {
    expect(taskFailureGuidance(job, failureEvent(true))).toMatchObject({
      retryable: true,
      categoryLabel: "网络或临时服务",
      actionLabel: "返回原入口",
    });
    expect(taskFailureGuidance(
      { ...job, error_code: "invalid_job_input" },
      { ...failureEvent(false), payload: { code: "invalid_job_input", retryable: false } },
    )).toMatchObject({ retryable: false, categoryLabel: "输入校验" });
  });

  it("routes tool failures to the correction surface", () => {
    expect(taskFailureGuidance(
      { ...job, kind: "tool.install.pdf2zh", error_code: "installer_missing" },
      { ...failureEvent(false), payload: { code: "installer_missing", retryable: false } },
    )).toMatchObject({ href: "/settings", actionLabel: "打开系统设置" });
  });
});

describe("task center default view", () => {
  it("opens the first actionable non-empty view", () => {
    const run = { status: "running" } as AgentRun;
    const change = { status: "submitted" } as ChangeSet;
    expect(defaultTaskKind([job], [], [])).toBe("jobs");
    expect(defaultTaskKind([], [run], [])).toBe("agents");
    expect(defaultTaskKind([job], [run], [change])).toBe("changes");
  });
});
