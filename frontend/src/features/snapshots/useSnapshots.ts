import { useCallback, useEffect, useState } from "react";

import { api } from "../../shared/api/client";
import type { SnapshotOverview } from "../../shared/api/contracts";

export function useSnapshots() {
  const [overview, setOverview] = useState<SnapshotOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await api.snapshots());
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取备份状态");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (overview?.operation?.status !== "running") return;
    const timer = window.setTimeout(() => void load(), 1500);
    return () => window.clearTimeout(timer);
  }, [load, overview]);

  const create = useCallback(async () => {
    setError(null);
    try {
      const operation = await api.createSnapshot();
      setOverview((current) => ({ snapshots: current?.snapshots ?? [], operation }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法开始备份");
      await load();
    }
  }, [load]);

  const restore = useCallback(async (filename: string) => {
    const confirmed = window.confirm(
      `确定使用 ${filename} 恢复全部学习数据吗？当前数据会保留为恢复副本。`,
    );
    if (!confirmed) return;
    setError(null);
    try {
      const operation = await api.restoreSnapshot(filename);
      setOverview((current) => ({ snapshots: current?.snapshots ?? [], operation }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法开始恢复");
      await load();
    }
  }, [load]);

  return { overview, loading, error, create, restore };
}
