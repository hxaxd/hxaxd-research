import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { api } from "../shared/api/client";
import type { Project, ProjectCreate, Workspace } from "../shared/api/contracts";

type ConnectionState = "connecting" | "connected" | "disconnected";

interface AppData {
  workspace: Workspace | null;
  projects: Project[];
  loading: boolean;
  connection: ConnectionState;
  error: string | null;
  refresh: () => Promise<void>;
  createProject: (payload: ProjectCreate) => Promise<Project>;
}

const Context = createContext<AppData | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setConnection("connecting");
    const [workspaceResult, projectsResult] = await Promise.allSettled([
      api.workspace(),
      api.projects(),
    ]);
    if (workspaceResult.status === "fulfilled") {
      setWorkspace(workspaceResult.value);
      setConnection("connected");
      setError(null);
    } else {
      setWorkspace(null);
      setConnection("disconnected");
      setError(workspaceResult.reason instanceof Error ? workspaceResult.reason.message : "后端不可用");
    }
    if (projectsResult.status === "fulfilled") setProjects(projectsResult.value);
    setLoading(false);
  }, []);

  const createProject = useCallback(
    async (payload: ProjectCreate) => {
      const project = await api.createProject(payload);
      await refresh();
      return project;
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ workspace, projects, loading, connection, error, refresh, createProject }),
    [workspace, projects, loading, connection, error, refresh, createProject],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAppData() {
  const value = useContext(Context);
  if (!value) throw new Error("useAppData must be used inside AppDataProvider");
  return value;
}
