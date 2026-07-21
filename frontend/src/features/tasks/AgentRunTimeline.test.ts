import { describe, expect, it } from "vitest";

import { eventLabel } from "./AgentRunTimeline";

describe("agent event labels", () => {
  it("turns machine event types into stable user-facing stages", () => {
    expect(eventLabel("tool.started")).toBe("正在调用工具");
    expect(eventLabel("tool.completed")).toBe("工具调用完成");
    expect(eventLabel("approval.requested")).toBe("请求用户批准");
    expect(eventLabel("source.evidence.added")).toBe("发现新的来源证据");
  });
});
