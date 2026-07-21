/*
 * Single contract seam for the UI. This file is intentionally the only handwritten
 * API shape and can be replaced by OpenAPI generation without changing components.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Capability {
  supported: boolean;
  ready: boolean;
  message: string;
  details: Record<string, string | number | boolean | null>;
}
export interface Workspace {
  generated_at: string;
  contract_version: string;
  schema_version: number;
  counts: Record<string, number>;
  projects: WorkspaceProject[];
  capabilities: Record<string, Capability>;
}

export interface WorkspaceProject {
  id: string;
  name: string;
  description: string;
  item_count: number;
  candidate_count: number;
  status_counts: Record<string, number>;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  work_count: number;
  status_counts: Record<string, number>;
  created_at: string;
  updated_at: string;
}

export interface ProjectCreate {
  name: string;
  description: string;
}

export type ProjectItemStatus = "discovered" | "included" | "excluded" | "archived";

export interface ProjectItem {
  id: string;
  project_id: string;
  work_id: string;
  status: ProjectItemStatus;
  roles: string[];
  summary: string | null;
  relevance: string | null;
  contributions: string[];
  reading_focus: string[];
  preferred_item_id: string;
  title: string;
  translated_title: string | null;
  item_type: string;
  issued_year: number | null;
  decided_at: string | null;
  decided_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectItemUpdate {
  status?: ProjectItemStatus;
  roles?: string[];
  summary?: string | null;
  relevance?: string | null;
  contributions?: string[];
  reading_focus?: string[];
}

export interface Creator {
  id: string;
  position: number;
  role: string;
  creator_type: "person" | "organization" | "literal";
  given_name: string | null;
  family_name: string | null;
  literal_name: string | null;
  suffix: string | null;
  orcid: string | null;
  raw_name: string;
}

export interface Identifier {
  id: string;
  scheme: string;
  value: string;
  normalized_value: string;
  version: string | null;
  is_primary: boolean;
  is_identity: boolean;
}

export interface BibliographicLink {
  id: string;
  relation_type: string;
  url: string;
  title: string | null;
}

export interface BibliographicTag {
  name: string;
  kind: string;
}

export interface BibliographicItem {
  id: string;
  work_id: string;
  revision: number;
  item_type: string;
  title: string;
  short_title: string | null;
  translated_title: string | null;
  abstract: string | null;
  language: string | null;
  issued_year: number | null;
  issued_month: number | null;
  issued_day: number | null;
  issued_literal: string | null;
  container_title: string | null;
  publisher: string | null;
  place: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  edition: string | null;
  series: string | null;
  publication_state: string;
  creator_list_complete: boolean;
  is_preferred_for_work: boolean;
  creators: Creator[];
  identifiers: Identifier[];
  links: BibliographicLink[];
  tags: BibliographicTag[];
  created_at: string;
  updated_at: string;
}

export type CandidateState = "staged" | "matched" | "promoted" | "dismissed";

export interface CandidateEvidence {
  id: string;
  provider: string;
  external_key: string | null;
  url: string | null;
  captured_at: string | null;
  summary: string | null;
  fields: Record<string, JsonValue>;
}

export interface CandidateDraft {
  item_type: string;
  title: string;
  translated_title?: string | null;
  abstract?: string | null;
  issued_year?: number | null;
  container_title?: string | null;
  creators: Array<Pick<Creator, "role" | "creator_type" | "given_name" | "family_name" | "literal_name" | "raw_name">>;
  identifiers: Array<Pick<Identifier, "scheme" | "value" | "is_primary">>;
}

export interface Candidate {
  id: string;
  project_id: string;
  discovery_session_id: string | null;
  source_record_id: string | null;
  state: CandidateState;
  item: CandidateDraft;
  dedupe_key: string | null;
  matched_work_id: string | null;
  rank: number | null;
  rationale: string | null;
  evidence: CandidateEvidence[];
  created_at: string;
  resolved_at: string | null;
}

export interface CandidateDecision {
  candidate_id: string;
  decision: "include" | "exclude";
  matched_work_id?: string | null;
  reason?: string | null;
}

export interface CandidateDecisionResult {
  candidate: Candidate;
  project_item: ProjectItem | null;
}

export type AttachmentFormat = "pdf" | "tex" | "other";
export type AttachmentLanguageMode = "original" | "translated" | "bilingual";

export interface Attachment {
  id: string;
  item_id: string;
  attachment_type: "fulltext" | "source_archive" | "supplement" | "other";
  format: AttachmentFormat;
  language_mode: AttachmentLanguageMode;
  origin: "publisher" | "preprint" | "author" | "user" | "generated" | "legacy" | "zotero";
  filename: string;
  media_type: string;
  sha256: string;
  size: number;
  preferred_for: string[];
  created_at: string;
}

export type DocumentStatus = "extracting" | "ready" | "failed" | "superseded";
export type DocumentBlockKind =
  | "title"
  | "heading"
  | "paragraph"
  | "list"
  | "formula"
  | "table"
  | "figure"
  | "footnote"
  | "reference"
  | "other";
export type SemanticRole =
  | "background"
  | "question"
  | "method"
  | "evidence"
  | "result"
  | "limitation"
  | "conclusion"
  | "other";

export interface SemanticDocument {
  id: string;
  item_id: string;
  source_attachment_id: string;
  source_sha256: string;
  extractor: string;
  extractor_version: string;
  structure_version: string;
  status: DocumentStatus;
  language: string | null;
  page_count: number | null;
  block_count: number;
  structure_hash: string | null;
  created_by_job_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface BlockTranslation {
  id: string;
  block_id: string;
  target_language: string;
  translated_text: string;
  source_sha256: string;
  provider: string;
  model: string;
  prompt_version: string;
  batch_id: string;
  validation_status: string;
  created_by_job_id: string | null;
  created_at: string;
}

export interface DocumentBlock {
  id: string;
  document_id: string;
  parent_id: string | null;
  ordinal: number;
  kind: DocumentBlockKind;
  semantic_role: SemanticRole | null;
  source_text: string;
  source_sha256: string;
  page_start: number | null;
  page_end: number | null;
  anchor: Record<string, JsonValue>;
  section_path: string[];
  created_at: string;
  translation: BlockTranslation | null;
}

export interface DocumentBlocksPage {
  document_id: string;
  offset: number;
  limit: number;
  total: number;
  items: DocumentBlock[];
}

export type AnnotationKind =
  | "highlight"
  | "excerpt"
  | "question"
  | "claim"
  | "method"
  | "result"
  | "limitation"
  | "bibliographic_note";

export interface AnnotationCreate {
  attachment_id: string | null;
  block_id: string | null;
  kind: AnnotationKind;
  body: string;
  quoted_text: string | null;
  page_number: number | null;
  anchor: Record<string, JsonValue>;
  tags: string[];
}

export interface AnnotationUpdate {
  expected_updated_at: string;
  kind: AnnotationKind;
  body: string;
  tags: string[];
}

export interface Annotation {
  id: string;
  project_id: string | null;
  item_id: string;
  attachment_id: string | null;
  block_id: string | null;
  kind: AnnotationKind;
  body: string;
  quoted_text: string | null;
  source_sha256: string | null;
  page_number: number | null;
  anchor: Record<string, JsonValue>;
  anchor_status: "valid" | "stale" | "unresolved";
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface ReadingBookmarkCreate {
  block_id: string | null;
  page_number: number | null;
  label: string;
}

export interface ReadingBookmark {
  id: string;
  block_id: string | null;
  page_number: number | null;
  label: string;
  created_at: string;
}

export interface ReadingStateUpdate {
  attachment_id: string | null;
  block_id: string | null;
  page_number: number | null;
  progress: number;
}

export interface ReadingState {
  attachment_id: string | null;
  block_id: string | null;
  page_number: number | null;
  progress: number;
  project_id: string;
  item_id: string;
  bookmarks: ReadingBookmark[];
  updated_at: string | null;
}

export interface ReaderPreferences {
  target_language: string;
  default_mode: "source" | "bilingual" | "translation";
  default_panel: "structured" | "pdf" | "split";
  font_family: "serif" | "sans" | "system";
  font_size: "small" | "medium" | "large";
  line_height: "compact" | "standard" | "relaxed";
  measure: "focused" | "balanced" | "wide";
  density: "compact" | "comfortable";
  flow: "continuous" | "paged";
  columns: "auto" | "single" | "double";
  theme: "dark" | "light" | "sepia";
  show_outline: boolean;
  restore_position: boolean;
  large_touch_targets: boolean;
  reduce_motion: boolean;
}

export interface BilingualPreferences {
  layout: "side_by_side" | "stacked";
  highlight_terms: boolean;
  synchronize_blocks: boolean;
}

export interface PdfPreferences {
  color_mode: "original" | "dark" | "sepia";
  default_zoom: "auto" | "page_width" | "page_fit";
  toolbar_density: "compact" | "comfortable";
  restore_position: boolean;
}

export interface GlossaryPreference {
  source_term: string;
  translated_term: string;
}

export interface TranslationPreferences {
  provider: string;
  model: string;
  style: "faithful_academic" | "natural_academic" | "concise";
  batching: "whole_with_fallback" | "whole_only" | "chapter";
  glossary: GlossaryPreference[];
  retranslate_scope: "changed" | "document";
}

export interface AgentPreferences {
  model: string | null;
  reasoning_effort: "low" | "medium" | "high" | "xhigh";
  enabled_capabilities: Array<"catalog_read" | "candidate_propose" | "metadata_propose" | "resource_propose" | "zotero_conflict_propose" | "web_search">;
  context_summary: "compact" | "balanced" | "detailed";
}

export interface TaskPreferences {
  notify_on_success: boolean;
  notify_on_failure: boolean;
  auto_open_result: boolean;
  max_concurrent_jobs: number;
}

export interface UserPreferences {
  revision: number;
  reader: ReaderPreferences;
  bilingual: BilingualPreferences;
  pdf: PdfPreferences;
  translation: TranslationPreferences;
  agent: AgentPreferences;
  tasks: TaskPreferences;
  updated_at: string | null;
}

export interface UserPreferencesUpdate {
  expected_revision: number;
  reader: ReaderPreferences;
  bilingual: BilingualPreferences;
  pdf: PdfPreferences;
  translation: TranslationPreferences;
  agent: AgentPreferences;
  tasks: TaskPreferences;
}

export interface DeviceAccessStatus {
  lan_enabled: boolean;
  local_request: boolean;
  authenticated: boolean;
  pairing_required: boolean;
  session_id: string | null;
  cookie_secure: boolean;
}

export interface PairingCreate {
  label: string | null;
  ttl_seconds: number;
}

export interface PairingTicket {
  id: string;
  code: string;
  expires_at: string;
}

export interface PairDeviceRequest {
  code: string;
  label: string;
}

export interface DeviceSession {
  id: string;
  label: string;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  current: boolean;
}

export interface PairedDevice {
  status: DeviceAccessStatus;
  session: DeviceSession;
}

export type JobStatus =
  | "queued"
  | "running"
  | "cancellation_requested"
  | "canceled"
  | "succeeded"
  | "failed";

export interface Job {
  id: string;
  kind: string;
  subject_type: string | null;
  subject_id: string | null;
  status: JobStatus;
  priority: number;
  error_code: string | null;
  error_message: string | null;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancel_requested_at: string | null;
}

export interface JobEvent {
  id: number;
  job_id: string;
  event_type: string;
  level: string;
  payload: Record<string, JsonValue>;
  created_at: string;
}

export type AgentRunStatus =
  | "created"
  | "starting"
  | "running"
  | "waiting_approval"
  | "cancellation_requested"
  | "canceled"
  | "completed"
  | "failed";

export interface AgentRun {
  id: string;
  task_kind: string;
  status: AgentRunStatus;
  goal: string;
  project_id: string | null;
  item_id: string | null;
  target_type: string | null;
  target_id: string | null;
  tool_scopes: string[];
  runtime: string;
  runtime_version: string | null;
  model: string | null;
  reasoning_effort: string | null;
  final_message: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancel_requested_at: string | null;
}

export interface AgentRunCreate {
  task_kind: string;
  goal: string;
  project_id?: string | null;
  item_id?: string | null;
  zotero_preview_id?: string | null;
}

export interface AgentRunLaunch {
  run: AgentRun;
  job_id: string;
}

export type ChangeSetStatus =
  | "draft"
  | "submitted"
  | "partially_applied"
  | "applied"
  | "rejected"
  | "stale"
  | "failed";

export type ChangeItemStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "applied"
  | "stale"
  | "failed";

export interface ChangeEvidence {
  source: string;
  url: string | null;
  locator: string | null;
  quote: string | null;
  metadata: Record<string, JsonValue>;
}

export interface ChangeItem {
  id: string;
  position: number;
  operation: string;
  target_type: string;
  target_id: string;
  base_revision: string | null;
  status: ChangeItemStatus;
  payload: Record<string, JsonValue>;
  evidence: ChangeEvidence[];
  result: Record<string, JsonValue> | null;
  rationale: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  reviewed_at: string | null;
  applied_at: string | null;
}

export interface ChangeSet {
  id: string;
  kind:
    | "metadata_patch"
    | "resource_acquisition"
    | "project_insights"
    | "zotero_conflict_resolution";
  status: ChangeSetStatus;
  agent_run_id: string | null;
  project_id: string | null;
  item_id: string | null;
  source_version: string | null;
  content_hash: string;
  summary: string;
  items: ChangeItem[];
  created_at: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  applied_at: string | null;
}

export interface ChangeSetList {
  items: ChangeSet[];
  total: number;
  limit: number;
  offset: number;
}

export interface ChangeReviewDecision {
  change_item_id: string;
  decision: "approve" | "reject";
}

export interface AgentEvent {
  id: number;
  run_id: string;
  event_type: string;
  visibility: "public" | "internal";
  payload: Record<string, JsonValue>;
  created_at: string;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface Approval {
  id: string;
  run_id: string;
  kind: string;
  status: ApprovalStatus;
  approvable: boolean;
  request: Record<string, JsonValue>;
  decision: "approve" | "deny" | "cancel" | null;
  created_at: string;
  decided_at: string | null;
}

export type TransferAction = "new" | "update" | "unchanged" | "conflict" | "blocked";

export interface TransferDifference {
  field: string;
  source: JsonValue;
  target: JsonValue;
}

export interface TransferConflict {
  id: string;
  item_id: string;
  kind: string;
  message: string;
  fields: string[];
}

export interface TransferConflictResolution {
  conflict_id: string;
  choice: "source" | "target" | "manual" | "skip";
  manual_changes: Record<string, JsonValue> | null;
  resolved_at: string | null;
}

export interface TransferPlanItem {
  item_id: string;
  action: TransferAction;
  differences: TransferDifference[];
  conflicts: TransferConflict[];
  blocked_reason: string | null;
}

export interface TransferPreview {
  id: string;
  direction: "import" | "export";
  created_at: string;
  expires_at: string;
  items: TransferPlanItem[];
  summary: Record<TransferAction | "total", number>;
  preview_hash: string;
}

export interface TransferPreviewRequest {
  direction: "import" | "export";
  library: { kind: "users" | "groups"; id: string };
  project_id: string;
  ttl_seconds?: number;
}

export interface TransferReceipt {
  id: string;
  preview_id: string;
  preview_hash: string;
  status: "succeeded" | "partial" | "failed";
  started_at: string;
  finished_at: string;
  items: Array<{
    item_id: string;
    planned_action: TransferAction;
    outcome: "created" | "updated" | "unchanged" | "skipped" | "failed";
    message: string | null;
  }>;
}

export type ManagedToolName = "pdf2zh" | "tex";
export type ManagedToolStatus = "missing" | "upgrade_required" | "installing" | "ready" | "failed";

export interface ManagedTool {
  name: ManagedToolName;
  label: string;
  description: string;
  status: ManagedToolStatus;
  version: string | null;
  message: string;
}

export interface AttachmentDownloadRequest {
  url: string;
  filename?: string | null;
  attachment_type: Attachment["attachment_type"];
  language_mode: AttachmentLanguageMode;
  origin: Attachment["origin"];
  preferred_for: string[];
}

export interface SnapshotItem {
  filename: string;
  size: number;
  created_at: string;
  download_url: string;
}

export interface SnapshotOverview {
  snapshots: SnapshotItem[];
}

export interface ZoteroEndpointStatus {
  available: boolean;
  read_only: boolean;
  message: string;
}

export interface ZoteroIntegrationStatus {
  local: ZoteroEndpointStatus;
  web: ZoteroEndpointStatus;
  import_available: boolean;
  export_available: boolean;
}
