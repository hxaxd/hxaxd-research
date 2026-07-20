import { useCallback, useEffect, useState } from "react";

import { api } from "../../shared/api/client";
import type { ManagedTool, ToolName } from "../../shared/api/contracts";

export function useTools() {
  const [tools, setTools] = useState<ManagedTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const nextTools = await api.tools();
      setTools(nextTools);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取工具状态");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!tools.some((tool) => tool.status === "installing")) return;
    const timer = window.setTimeout(() => void load(), 1800);
    return () => window.clearTimeout(timer);
  }, [load, tools]);

  const install = useCallback(async (name: ToolName) => {
    setError(null);
    setTools((current) => current.map((tool) => (
      tool.name === name
        ? { ...tool, status: "installing", message: "正在启动安装…" }
        : tool
    )));
    try {
      const updated = await api.installTool(name);
      setTools((current) => current.map((tool) => tool.name === name ? updated : tool));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法启动安装");
      await load();
    }
  }, [load]);

  return { tools, loading, error, install };
}
