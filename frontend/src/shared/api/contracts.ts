export type PaperStatus = "discovered" | "included" | "excluded" | "archived";

export type PaperType =
  | "综述"
  | "奠基"
  | "方法"
  | "系统"
  | "Benchmark"
  | "反例"
  | "相邻工作";

export type ArtifactKind = "original" | "chinese" | "bilingual";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectSummary extends Project {
  paper_count: number;
}

export interface Paper {
  id: string;
  project_id: string;
  stable_key: string;
  status: PaperStatus;
  title_en: string;
  title_zh: string;
  authors: string[];
  organization: string | null;
  publication_year: number;
  publication_status: string;
  paper_type: PaperType;
  main_method: string;
  contribution: string;
  selection_reason: string;
  reading_focus: string;
  relations: string;
  stable_url: string;
  code_url: string | null;
  website_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Artifact {
  id: string;
  paper_id: string;
  kind: ArtifactKind;
  filename: string;
  relative_path: string;
  sha256: string;
  size: number;
  created_at: string;
}

export interface Job {
  id: string;
  paper_id: string;
  job_type: string;
  status: JobStatus;
  progress: number;
  message: string;
  error_summary: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
