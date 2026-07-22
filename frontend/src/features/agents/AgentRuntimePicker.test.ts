import { describe, expect, it } from "vitest";

import type { AgentRuntimeDefinition } from "../../shared/api/contracts";
import {
  agentRuntimeLabel,
  agentRuntimeModelLabel,
  resolveAgentRuntimeSelection,
} from "./AgentRuntimePicker";

const runtimes: AgentRuntimeDefinition[] = [
  { id: "codex", label: "Codex", transport: "app-server", ready: false, message: "不可用", version: null, model: null, supports_resume: true },
  { id: "pi", label: "Pi", transport: "rpc", ready: true, message: "已就绪", version: "0.73.1", model: "deepseek-v4-flash", supports_resume: true },
];

describe("agent runtime presentation", () => {
  it("keeps the launcher actionable when its saved default is unavailable", () => {
    expect(resolveAgentRuntimeSelection(runtimes, "codex")).toBe("pi");
    expect(resolveAgentRuntimeSelection(runtimes, "codex", "pi")).toBe("pi");
  });

  it("falls back to the first ready runtime when a saved id is not advertised", () => {
    expect(resolveAgentRuntimeSelection(runtimes.slice(1), "codex")).toBe("pi");
  });

  it("distinguishes the configurable Codex model from fixed DeepSeek runtimes", () => {
    expect(agentRuntimeModelLabel(runtimes[0]!, "gpt-5.6-sol")).toBe("Codex 模型 · gpt-5.6-sol");
    expect(agentRuntimeModelLabel(runtimes[1]!)).toBe("固定模型 · DeepSeek V4 Flash");
    expect(agentRuntimeLabel("claude-code")).toBe("Claude Code");
  });
});
