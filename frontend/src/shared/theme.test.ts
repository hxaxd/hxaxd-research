import { describe, expect, it, vi } from "vitest";

import {
  normalizeWorkspaceTheme,
  resolveWorkspaceTheme,
  updateWorkspaceThemeColor,
  workspaceThemeColor,
} from "./theme";

describe("workspace theme", () => {
  it("keeps explicit device preferences and rejects stale values", () => {
    expect(normalizeWorkspaceTheme("light")).toBe("light");
    expect(normalizeWorkspaceTheme("dark")).toBe("dark");
    expect(normalizeWorkspaceTheme("sepia")).toBe("system");
    expect(normalizeWorkspaceTheme(null)).toBe("system");
  });

  it("resolves system mode without overriding an explicit choice", () => {
    expect(resolveWorkspaceTheme("system", true)).toBe("dark");
    expect(resolveWorkspaceTheme("system", false)).toBe("light");
    expect(resolveWorkspaceTheme("light", true)).toBe("light");
    expect(resolveWorkspaceTheme("dark", false)).toBe("dark");
  });

  it("keeps the browser chrome in sync with the resolved warm theme", () => {
    expect(workspaceThemeColor("light")).toBe("#f2f0e5");
    expect(workspaceThemeColor("dark")).toBe("#100f0f");
    const meta = { setAttribute: vi.fn() } as unknown as HTMLMetaElement;

    updateWorkspaceThemeColor("dark", meta);

    expect(meta.setAttribute).toHaveBeenCalledWith("content", "#100f0f");
  });
});
