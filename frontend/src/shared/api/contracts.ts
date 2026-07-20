export type PaperStatus = "discovered" | "included" | "excluded" | "archived";
export type PublicationState = "preprint" | "accepted" | "published" | "unknown";
export type PaperRole = "综述" | "奠基" | "方法" | "系统" | "Benchmark" | "反例" | "相邻工作";
export type ResourceFormat = "pdf" | "tex";
export type ResourceRepresentation = "original" | "translated" | "bilingual";
export type ResourceOrigin = "publisher" | "preprint" | "author" | "user" | "generated" | "legacy";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export type JobOperation = "compile" | "translate";
export type ToolName = "pdf2zh" | "tex";
export type ToolStatus = "missing" | "installing" | "installed" | "failed";

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectSummary extends Project { paper_count: number }

export interface PaperIdentifier {
  id: string;
  scheme: string;
  value: string;
  normalized_value: string;
  is_primary: boolean;
  source: string | null;
}

export interface PaperLink { type: string; url: string }

export interface Paper {
  id: string;
  identity_key: string;
  title: string;
  title_zh: string | null;
  authors: string[];
  authors_complete: boolean;
  abstract: string | null;
  publication_year: number | null;
  venue: string | null;
  publication_state: PublicationState;
  identifiers: PaperIdentifier[];
  links: PaperLink[];
  created_at: string;
  updated_at: string;
}

export interface ProjectPaper {
  id: string;
  project_id: string;
  paper_id: string;
  status: PaperStatus;
  roles: PaperRole[];
  summary: string | null;
  contributions: string[];
  relevance: string | null;
  reading_focus: string[];
  created_at: string;
  updated_at: string;
}

export interface ProjectPaperView { paper: Paper; project: ProjectPaper; resources: Resource[] }

export interface Resource {
  id: string;
  paper_id: string;
  format: ResourceFormat;
  representation: ResourceRepresentation;
  origin: ResourceOrigin;
  source_url: string | null;
  filename: string;
  media_type: string;
  sha256: string;
  size: number;
  preferred: boolean;
  parent_resource_id: string | null;
  job_id: string | null;
  created_at: string;
}

export interface Job {
  id: string;
  paper_id: string;
  operation: JobOperation;
  input_resource_id: string | null;
  status: JobStatus;
  progress: number;
  options: Record<string, unknown>;
  tool: string | null;
  tool_version: string | null;
  message: string;
  log_excerpt: string | null;
  error_summary: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  outputs: Resource[];
}

export interface ManagedTool {
  name: ToolName; label: string; description: string; status: ToolStatus;
  install_path: string; executable_path: string | null; version: string | null; message: string;
}

export interface Capability {
  supported: boolean; ready: boolean; accepts: string[]; produces: string[];
  tool: string | null; tool_version: string | null; message: string;
}

export interface WorkspaceProject extends ProjectSummary {
  status_counts: Record<string, number>;
  resource_counts: Record<string, number>;
}

export interface Workspace {
  generated_at: string;
  contract_version: string;
  schema_version: number;
  projects: WorkspaceProject[];
  capabilities: Record<string, Capability>;
  tools: ManagedTool[];
}

export type SnapshotOperationKind = "backup" | "restore";
export type SnapshotOperationStatus = "running" | "succeeded" | "failed";
export interface SnapshotOperation {
  id: string; kind: SnapshotOperationKind; status: SnapshotOperationStatus;
  message: string; filename: string | null; error: string | null;
  started_at: string; finished_at: string | null;
}
export interface SnapshotItem { filename: string; size: number; created_at: string; download_url: string }
export interface SnapshotOverview { snapshots: SnapshotItem[]; operation: SnapshotOperation | null }
