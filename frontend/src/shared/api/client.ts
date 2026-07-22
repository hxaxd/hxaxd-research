import type {
  AgentRun,
  AgentRunCreate,
  AgentRunLaunch,
  AgentTaskDefinition,
  Annotation,
  AnnotationCreate,
  AnnotationUpdate,
  Approval,
  Attachment,
  AttachmentDownloadRequest,
  BibliographicItem,
  Candidate,
  CandidateDecision,
  CandidateDecisionResult,
  ChangeReviewDecision,
  ChangeSet,
  ChangeSetList,
  ChangeSetStatus,
  DocumentBlocksPage,
  DeviceAccessStatus,
  DeviceSession,
  Job,
  ManagedTool,
  ManagedToolName,
  Project,
  ProjectCreate,
  ProjectItem,
  ProjectItemStatus,
  ProjectItemUpdate,
  PairedDevice,
  PairDeviceRequest,
  PairingCreate,
  PairingTicket,
  ReadingBookmarkCreate,
  ReadingState,
  ReadingStateUpdate,
  SemanticDocument,
  SnapshotOverview,
  TransferConflictResolution,
  TransferPreview,
  TransferPreviewRequest,
  TransferReceipt,
  UserPreferences,
  UserPreferencesUpdate,
  Workspace,
  ZoteroIntegrationStatus,
} from "./contracts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
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
    const payload = (await response.json().catch(() => null)) as {
      detail?: string | { message?: string };
      message?: string;
      code?: string;
      details?: unknown;
    } | null;
    const detail =
      typeof payload?.detail === "string" ? payload.detail : payload?.detail?.message;
    throw new ApiError(
      payload?.message ?? detail ?? `请求失败：${response.status}`,
      response.status,
      payload?.code,
      payload?.details,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function query(values: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export const api = {
  workspace: () => request<Workspace>("/workspace"),
  projects: () => request<Project[]>("/projects"),
  createProject: (payload: ProjectCreate) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify(payload) }),
  project: (projectId: string) => request<Project>(`/projects/${projectId}`),
  projectItems: (projectId: string, status?: ProjectItemStatus | "all") =>
    request<ProjectItem[]>(
      `/projects/${projectId}/items${query({ status: status === "all" ? null : status })}`,
    ),
  updateProjectItem: (projectId: string, workId: string, payload: ProjectItemUpdate) =>
    request<ProjectItem>(`/projects/${projectId}/works/${workId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  candidates: (projectId: string) =>
    request<Candidate[]>(`/projects/${projectId}/candidates`),
  decideCandidates: (projectId: string, decisions: CandidateDecision[]) =>
    request<CandidateDecisionResult[]>(`/projects/${projectId}/candidate-decisions`, {
      method: "POST",
      body: JSON.stringify({ decisions }),
    }),
  item: (itemId: string) => request<BibliographicItem>(`/items/${itemId}`),
  attachments: (itemId: string) => request<Attachment[]>(`/items/${itemId}/attachments`),
  uploadAttachment: (
    itemId: string,
    file: File,
    metadata: {
      attachment_type: Attachment["attachment_type"];
      language_mode: Attachment["language_mode"];
      origin: Attachment["origin"];
      source_url?: string | null;
      preferred_for?: string[];
    },
  ) => {
    const body = new FormData();
    body.append("upload", file);
    body.append("attachment_type", metadata.attachment_type);
    body.append("language_mode", metadata.language_mode);
    body.append("origin", metadata.origin);
    if (metadata.source_url) body.append("source_url", metadata.source_url);
    for (const purpose of metadata.preferred_for ?? []) body.append("preferred_for", purpose);
    return request<Attachment>(`/items/${itemId}/attachments`, { method: "POST", body });
  },
  acquireAttachment: (
    itemId: string,
    payload: AttachmentDownloadRequest,
    projectId: string,
  ) =>
    request<Job>(`/items/${itemId}/attachments/download${query({ project_id: projectId })}`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  compileAttachment: (attachmentId: string, mainTex: string | null, projectId: string) =>
    request<Job>(`/attachments/${attachmentId}/compile${query({ project_id: projectId })}`, {
      method: "POST",
      body: JSON.stringify({ main_tex: mainTex || null }),
    }),
  translateAttachment: (attachmentId: string, qps: number, workers: number, projectId: string) =>
    request<Job>(`/attachments/${attachmentId}/translate${query({ project_id: projectId })}`, {
      method: "POST",
      body: JSON.stringify({ qps, workers }),
    }),
  attachmentUrl: (attachmentId: string, sha256?: string) =>
    `/api/attachments/${attachmentId}/content${sha256 ? `?v=${sha256}` : ""}`,
  attachmentDownloadUrl: (attachmentId: string) =>
    `/api/attachments/${attachmentId}/content?download=true`,

  documents: (itemId: string) =>
    request<SemanticDocument[]>(`/items/${itemId}/documents`),
  document: (documentId: string) =>
    request<SemanticDocument>(`/documents/${documentId}`),
  documentBlocks: async (documentId: string, targetLanguage?: string | null) => {
    const pageSize = 1000;
    const items: DocumentBlocksPage["items"] = [];
    let firstPage: DocumentBlocksPage | null = null;
    let offset = 0;
    while (true) {
      const page = await request<DocumentBlocksPage>(
        `/documents/${documentId}/blocks${query({
          limit: pageSize,
          offset: offset || null,
          target_language: targetLanguage,
        })}`,
      );
      firstPage ??= page;
      if (page.document_id !== documentId || page.offset !== offset) {
        throw new Error("结构化文档分页响应与请求不一致");
      }
      items.push(...page.items);
      if (items.length >= page.total) break;
      if (!page.items.length) throw new Error("结构化文档分页提前结束");
      offset += page.items.length;
    }
    return {
      ...(firstPage as DocumentBlocksPage),
      offset: 0,
      limit: items.length,
      items,
    };
  },
  extractDocument: (attachmentId: string, ocrMode: "auto" | "force" | "off" = "auto") =>
    request<Job>(`/attachments/${attachmentId}/documents`, {
      method: "POST",
      body: JSON.stringify({ ocr_mode: ocrMode }),
    }),
  translateDocument: (documentId: string, targetLanguage = "zh-CN") =>
    request<Job>(`/documents/${documentId}/translate`, {
      method: "POST",
      body: JSON.stringify({ target_language: targetLanguage }),
    }),

  annotations: (projectId: string, itemId: string) =>
    request<Annotation[]>(`/projects/${projectId}/items/${itemId}/annotations`),
  createAnnotation: (projectId: string, itemId: string, payload: AnnotationCreate) =>
    request<Annotation>(`/projects/${projectId}/items/${itemId}/annotations`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateAnnotation: (annotationId: string, payload: AnnotationUpdate) =>
    request<Annotation>(`/annotations/${annotationId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  deleteAnnotation: (annotationId: string, expectedUpdatedAt: string) =>
    request<void>(
      `/annotations/${annotationId}${query({ expected_updated_at: expectedUpdatedAt })}`,
      { method: "DELETE" },
    ),
  readingState: (projectId: string, itemId: string) =>
    request<ReadingState>(`/projects/${projectId}/items/${itemId}/reading-state`),
  updateReadingState: (
    projectId: string,
    itemId: string,
    payload: ReadingStateUpdate,
  ) =>
    request<ReadingState>(`/projects/${projectId}/items/${itemId}/reading-state`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  addReadingBookmark: (
    projectId: string,
    itemId: string,
    payload: ReadingBookmarkCreate,
  ) =>
    request<ReadingState>(
      `/projects/${projectId}/items/${itemId}/reading-state/bookmarks`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  deleteReadingBookmark: (
    projectId: string,
    itemId: string,
    bookmarkId: string,
  ) =>
    request<ReadingState>(
      `/projects/${projectId}/items/${itemId}/reading-state/bookmarks/${bookmarkId}`,
      { method: "DELETE" },
    ),
  userPreferences: () => request<UserPreferences>("/user-preferences"),
  updateUserPreferences: (payload: UserPreferencesUpdate) =>
    request<UserPreferences>("/user-preferences", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  deviceAccessStatus: () => request<DeviceAccessStatus>("/device-access/status"),
  createDevicePairing: (payload: PairingCreate) =>
    request<PairingTicket>("/device-access/pairings", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  pairDevice: (payload: PairDeviceRequest) =>
    request<PairedDevice>("/device-access/pair", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deviceSessions: () => request<DeviceSession[]>("/device-access/sessions"),
  revokeDeviceSession: (sessionId: string) =>
    request<DeviceSession>(`/device-access/sessions/${sessionId}`, { method: "DELETE" }),

  jobs: () => request<Job[]>("/jobs"),
  job: (jobId: string) => request<Job>(`/jobs/${jobId}`),
  cancelJob: (jobId: string) => request<Job>(`/jobs/${jobId}/cancel`, { method: "POST" }),
  jobEventsUrl: (jobId: string, after = 0) => `/api/jobs/${jobId}/events${query({ after })}`,

  tools: () => request<ManagedTool[]>("/tools"),
  installTool: (name: ManagedToolName) =>
    request<Job>(`/tools/${name}/install`, { method: "POST" }),

  snapshots: () => request<SnapshotOverview>("/snapshots"),
  createSnapshot: () => request<Job>("/snapshots", { method: "POST" }),
  restoreSnapshot: (filename: string, confirmation: string) =>
    request<Job>(`/snapshots/${encodeURIComponent(filename)}/restore`, {
      method: "POST",
      body: JSON.stringify({ confirmation }),
    }),

  agentRuns: () => request<AgentRun[]>("/agent-runs"),
  agentTaskDefinitions: () =>
    request<AgentTaskDefinition[]>("/agent-task-definitions"),
  agentRun: (runId: string) => request<AgentRun>(`/agent-runs/${runId}`),
  createAgentRun: (payload: AgentRunCreate) =>
    request<AgentRunLaunch>("/agent-runs", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  interruptAgentRun: (runId: string) =>
    request<AgentRun>(`/agent-runs/${runId}/interrupt`, { method: "POST" }),
  resumeAgentRun: (runId: string) =>
    request<AgentRunLaunch>(`/agent-runs/${runId}/resume`, { method: "POST" }),
  agentEventsUrl: (runId: string, after = 0) =>
    `/api/agent-runs/${runId}/events${query({ after })}`,
  approvals: (runId: string) => request<Approval[]>(`/agent-runs/${runId}/approvals`),
  approve: (approvalId: string) =>
    request<Approval>(`/approvals/${approvalId}/approve`, { method: "POST" }),
  reject: (approvalId: string) =>
    request<Approval>(`/approvals/${approvalId}/reject`, { method: "POST" }),

  changeSets: (filters: {
    status?: ChangeSetStatus;
    projectId?: string;
    itemId?: string;
  } = {}) =>
    request<ChangeSetList>(
      `/change-sets${query({
        status: filters.status,
        project_id: filters.projectId,
        item_id: filters.itemId,
      })}`,
    ),
  reviewChangeSet: (
    changeSetId: string,
    expectedContentHash: string,
    decisions: ChangeReviewDecision[],
  ) =>
    request<ChangeSet>(`/change-sets/${changeSetId}/review`, {
      method: "POST",
      body: JSON.stringify({
        expected_content_hash: expectedContentHash,
        decisions,
      }),
    }),
  applyChangeSet: (changeSetId: string, expectedContentHash: string) =>
    request<ChangeSet>(`/change-sets/${changeSetId}/apply`, {
      method: "POST",
      body: JSON.stringify({ expected_content_hash: expectedContentHash }),
    }),

  previewZoteroTransfer: (payload: TransferPreviewRequest) =>
    request<TransferPreview>("/zotero/transfers/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  executeZoteroTransfer: (previewId: string, expectedPreviewHash: string) =>
    request<TransferReceipt>(`/zotero/transfers/${previewId}/execute`, {
      method: "POST",
      body: JSON.stringify({ confirmed: true, expected_preview_hash: expectedPreviewHash }),
    }),
  zoteroStatus: () => request<ZoteroIntegrationStatus>("/zotero/status"),
  resolveZoteroConflict: (
    previewId: string,
    conflictId: string,
    choice: "source" | "target" | "skip",
  ) =>
    request<TransferConflictResolution>(`/zotero/transfers/${previewId}/conflicts/${conflictId}`, {
      method: "PUT",
      body: JSON.stringify({ conflict_id: conflictId, choice }),
    }),
};
