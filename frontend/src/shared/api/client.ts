import type {
  Artifact,
  ArtifactKind,
  Job,
  ManagedTool,
  Paper,
  Project,
  ProjectSummary,
  SnapshotOperation,
  SnapshotOverview,
  ToolName,
} from "./contracts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers:
      init?.body instanceof FormData
        ? init.headers
        : { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new ApiError(payload?.detail ?? `请求失败：${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

export const api = {
  projects: () => request<ProjectSummary[]>("/projects"),
  createProject: (name: string, description = "") =>
    request<Project>("/projects", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    }),
  project: (projectId: string) => request<Project>(`/projects/${projectId}`),
  papers: (projectId: string) => request<Paper[]>(`/projects/${projectId}/papers`),
  paper: (paperId: string) => request<Paper>(`/papers/${paperId}`),
  artifacts: (paperId: string) => request<Artifact[]>(`/papers/${paperId}/artifacts`),
  uploadOriginal: (paperId: string, file: File) => {
    const body = new FormData();
    body.append("upload", file);
    return request<Artifact>(`/papers/${paperId}/artifacts/original`, {
      method: "POST",
      body,
    });
  },
  translate: (paperId: string) =>
    request<Job>(`/papers/${paperId}/translate`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  job: (jobId: string) => request<Job>(`/jobs/${jobId}`),
  tools: () => request<ManagedTool[]>("/tools"),
  installTool: (name: ToolName) =>
    request<ManagedTool>(`/tools/${name}/install`, { method: "POST" }),
  snapshots: () => request<SnapshotOverview>("/snapshots"),
  createSnapshot: () => request<SnapshotOperation>("/snapshots", { method: "POST" }),
  restoreSnapshot: (filename: string) =>
    request<SnapshotOperation>(`/snapshots/${encodeURIComponent(filename)}/restore`, {
      method: "POST",
      body: JSON.stringify({ confirmation: filename }),
    }),
  snapshotDownloadUrl: (filename: string) =>
    `/api/snapshots/${encodeURIComponent(filename)}/download`,
  artifactUrl: (paperId: string, kind: ArtifactKind, sha256?: string) =>
    `/api/papers/${paperId}/artifacts/${kind}${sha256 ? `?v=${sha256}` : ""}`,
  artifactDownloadUrl: (paperId: string, kind: ArtifactKind) =>
    `/api/papers/${paperId}/artifacts/${kind}?download=true`,
};
