import type {
  Job,
  JobOperation,
  ManagedTool,
  Paper,
  Project,
  ProjectPaper,
  ProjectPaperView,
  ProjectSummary,
  Resource,
  ResourceFormat,
  ResourceOrigin,
  ResourceRepresentation,
  SnapshotOperation,
  SnapshotOverview,
  ToolName,
  Workspace,
} from "./contracts";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message) }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string; message?: string; code?: string } | null;
    throw new ApiError(payload?.message ?? payload?.detail ?? `请求失败：${response.status}`, response.status, payload?.code);
  }
  return (await response.json()) as T;
}

export const api = {
  workspace: () => request<Workspace>("/workspace"),
  projects: () => request<ProjectSummary[]>("/projects"),
  createProject: (name: string, description = "") => request<Project>("/projects", { method: "POST", body: JSON.stringify({ name, description }) }),
  project: (projectId: string) => request<Project>(`/projects/${projectId}`),
  papers: (projectId: string) => request<ProjectPaperView[]>(`/projects/${projectId}/papers`),
  paper: (paperId: string) => request<Paper>(`/papers/${paperId}`),
  paperProjects: (paperId: string) => request<ProjectPaper[]>(`/papers/${paperId}/projects`),
  resources: (paperId: string) => request<Resource[]>(`/papers/${paperId}/resources`),
  uploadResource: (
    paperId: string,
    file: File,
    format: ResourceFormat,
    representation: ResourceRepresentation = "original",
    origin: ResourceOrigin = "user",
  ) => {
    const body = new FormData();
    body.append("upload", file); body.append("format", format); body.append("representation", representation); body.append("origin", origin);
    return request<Resource>(`/papers/${paperId}/resources`, { method: "POST", body });
  },
  createJob: (operation: JobOperation, inputResourceId: string) => request<Job>("/jobs", { method: "POST", body: JSON.stringify({ operation, input_resource_id: inputResourceId, options: {} }) }),
  translate: (paperId: string) => request<Job>(`/papers/${paperId}/translate`, { method: "POST", body: JSON.stringify({}) }),
  job: (jobId: string) => request<Job>(`/jobs/${jobId}`),
  tools: () => request<ManagedTool[]>("/tools"),
  installTool: (name: ToolName) => request<ManagedTool>(`/tools/${name}/install`, { method: "POST" }),
  snapshots: () => request<SnapshotOverview>("/snapshots"),
  createSnapshot: () => request<SnapshotOperation>("/snapshots", { method: "POST" }),
  restoreSnapshot: (filename: string) => request<SnapshotOperation>(`/snapshots/${encodeURIComponent(filename)}/restore`, { method: "POST", body: JSON.stringify({ confirmation: filename }) }),
  snapshotDownloadUrl: (filename: string) => `/api/snapshots/${encodeURIComponent(filename)}/download`,
  resourceUrl: (resourceId: string, sha256?: string) => `/api/resources/${resourceId}/content${sha256 ? `?v=${sha256}` : ""}`,
  resourceDownloadUrl: (resourceId: string) => `/api/resources/${resourceId}/content?download=true`,
};
