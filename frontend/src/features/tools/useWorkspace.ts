import { useEffect, useState } from "react";

import { api } from "../../shared/api/client";
import type { Workspace } from "../../shared/api/contracts";

export function useWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api.workspace().then((value) => { if (active) setWorkspace(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "无法读取平台能力"); });
    return () => { active = false; };
  }, []);
  return { workspace, error };
}
