import { expect, test, type Page, type Route } from "@playwright/test";
import type { AgentRuntimeId, ChangeSet, Job, TransferPreview, TransferReceipt } from "../src/shared/api/contracts";

const NOW = "2026-07-22T08:00:00Z";
const PDF = "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgKHB5cGRmKQo+PgplbmRvYmoKMiAwIG9iago8PAovVHlwZSAvUGFnZXMKL0NvdW50IDEKL0tpZHMgWyA0IDAgUiBdCj4+CmVuZG9iagozIDAgb2JqCjw8Ci9UeXBlIC9DYXRhbG9nCi9QYWdlcyAyIDAgUgo+PgplbmRvYmoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUmVzb3VyY2VzIDw8Cj4+Ci9NZWRpYUJveCBbIDAuMCAwLjAgNjEyIDc5MiBdCi9QYXJlbnQgMiAwIFIKPj4KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDU0IDAwMDAwIG4gCjAwMDAwMDAxMTMgMDAwMDAgbiAKMDAwMDAwMDE2MiAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDUKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKPj4Kc3RhcnR4cmVmCjI1NgolJUVPRgo=";

interface MockState {
  candidates: ReturnType<typeof candidate>[];
  decisions: unknown[];
  changes: ChangeSet[];
  jobs: Job[];
  runs: ReturnType<typeof agentRun>[];
  projectItem: ReturnType<typeof projectItem>;
  attachments: ReturnType<typeof attachment>[];
  preferencesFailures: number;
  preferenceUpdates: Array<Record<string, unknown>>;
  transfer: TransferPreview | null;
}

function creator(name = "Ada Example") {
  return { id: "creator-1", position: 0, role: "author", creator_type: "literal", given_name: null, family_name: null, literal_name: name, suffix: null, orcid: null, raw_name: name };
}

function identifier(value = "10.1000/semantic-reader") {
  return { id: `identifier-${value}`, scheme: "doi", value, normalized_value: value.toLowerCase(), version: null, is_primary: true, is_identity: true };
}

function item(id = "item-1") {
  return {
    id, work_id: "work-1", revision: 3, item_type: "journalArticle",
    title: "Semantic Reading for Long Scientific Papers", short_title: null,
    translated_title: "长篇科学论文的语义阅读", abstract: "A complete paper about non-linear reading interfaces.",
    language: "en", issued_year: 2026, issued_month: 6, issued_day: 1,
    issued_literal: "2026-06-01", container_title: "Journal of Traceable Systems",
    publisher: "Example Press", place: null, volume: "12", issue: "3", pages: "1-24",
    edition: null, series: null, publication_state: "published", creator_list_complete: true,
    is_preferred_for_work: true, creators: [creator()], identifiers: [identifier()],
    links: [{ id: "link-1", relation_type: "landing_page", url: "https://example.test/paper", title: "Publisher" }],
    tags: [{ name: "semantic-reader", kind: "keyword" }], created_at: NOW, updated_at: NOW,
  };
}

function projectItem() {
  return {
    id: "project-item-1", project_id: "project-1", work_id: "work-1", status: "included",
    roles: ["core"], summary: "阅读器架构的核心论文", relevance: "直接回答结构化阅读问题",
    contributions: ["稳定语义块"], reading_focus: ["方法与局限"], preferred_item_id: "item-1",
    title: item().title, translated_title: item().translated_title, item_type: "journalArticle",
    issued_year: 2026, decided_at: NOW, decided_by: "user", created_at: NOW, updated_at: NOW,
  };
}

function attachment(id = "attachment-1", filename = "semantic-reading.pdf") {
  return {
    id, item_id: "item-1", attachment_type: "fulltext", format: "pdf",
    language_mode: "original", origin: id === "attachment-1" ? "publisher" : "preprint",
    filename, media_type: "application/pdf", sha256: "b".repeat(64), size: 512000,
    preferred_for: ["read"], created_at: NOW,
  } as const;
}

function candidate(index: number) {
  const matched = index === 0;
  return {
    id: `candidate-${index}`, project_id: "project-1", discovery_session_id: "run-1",
    source_record_id: `crossref-${index}`, state: matched ? "matched" : "staged",
    item: {
      item_type: "journalArticle", title: `Traceable candidate ${String(index + 1).padStart(3, "0")}`,
      translated_title: `可追踪候选 ${index + 1}`, abstract: "A sourced candidate with enough evidence for review.",
      issued_year: 2026 - (index % 4), container_title: index % 2 ? "Archive" : "Systems Journal",
      creators: [{ role: "author", creator_type: "literal", given_name: null, family_name: null, literal_name: `Researcher ${index + 1}`, raw_name: `Researcher ${index + 1}` }],
      identifiers: [{ scheme: "doi", value: `10.2000/candidate.${index + 1}`, is_primary: true }],
    },
    dedupe_key: `doi:${index}`, matched_work_id: matched ? "work-1" : null,
    matched_item: matched ? item() : null, rank: index + 1,
    rationale: "与当前项目的问题和方法范围直接相关。",
    evidence: [{ id: `evidence-${index}`, provider: "Crossref", external_key: `key-${index}`, url: "https://example.test/source", captured_at: NOW, summary: "出版者元数据与摘要", fields: { doi: `10.2000/candidate.${index + 1}` } }],
    created_at: NOW, resolved_at: null,
  } as const;
}

function job(): Job {
  return { id: "job-1", kind: "document.translate", subject_type: "document", subject_id: "document-1", status: "failed", priority: 0, result: null, error_code: "provider_unavailable", error_message: "翻译服务暂时不可用", max_attempts: 3, created_at: NOW, updated_at: NOW, started_at: NOW, finished_at: NOW, cancel_requested_at: null };
}

function successfulResourceJob(): Job {
  return { id: "job-resource", kind: "attachment.download", subject_type: "item", subject_id: "item-1", status: "succeeded", priority: 0, result: { project_id: "project-1", item_id: "item-1", attachment_ids: ["attachment-2"] }, error_code: null, error_message: null, max_attempts: 3, created_at: NOW, updated_at: NOW, started_at: NOW, finished_at: NOW, cancel_requested_at: null };
}

function runningResourceJob(): Job {
  return { ...successfulResourceJob(), id: "job-direct", status: "running", result: null, finished_at: null };
}

function agentRun(id: string, taskKind: string, goal: string, runtime: AgentRuntimeId = "codex") {
  return {
    id, task_kind: taskKind, status: "completed", goal, project_id: "project-1",
    item_id: taskKind === "literature_search" ? null : "item-1", target_type: null,
    target_id: null, tool_scopes: [], runtime, runtime_version: "1",
    model: runtime === "codex" ? "gpt-5.6-sol" : "deepseek-v4-flash", reasoning_effort: "high", final_message: taskKind === "literature_search" ? "已暂存 1 条带来源证据的候选。" : "已提交资源获取变更建议。",
    error_code: null, error_message: null, created_at: NOW, updated_at: NOW,
    started_at: NOW, finished_at: NOW, cancel_requested_at: null,
  } as const;
}

function changeSet(): ChangeSet {
  return {
    id: "change-1", kind: "metadata_patch", status: "submitted", agent_run_id: "run-1",
    project_id: "project-1", item_id: "item-1", source_version: "3", content_hash: "hash-1",
    summary: "补全期刊名与出版年份", created_at: NOW, submitted_at: NOW,
    reviewed_at: null, reviewed_by: null, applied_at: null,
    items: [{
      id: "change-item-1", position: 0, operation: "metadata.patch",
      target_type: "bibliographic_item", target_id: "item-1", base_revision: "3",
      payload: { patch: { container_title: "Journal of Traceable Systems", issued_year: 2026 } },
      evidence: [{ source: "Crossref", locator: "10.1000/semantic-reader", url: "https://example.test/source", quote: null, metadata: { captured_at: NOW } }],
      rationale: "来源记录与出版者页面一致", status: "proposed", result: null,
      error_code: null, error_message: null, created_at: NOW, reviewed_at: null, applied_at: null,
    }],
  };
}

function resourceChangeSet(runId: string): ChangeSet {
  return {
    id: "change-resource", kind: "resource_acquisition", status: "submitted",
    agent_run_id: runId, project_id: "project-1", item_id: "item-1",
    source_version: "3", content_hash: "hash-resource", summary: "获取出版者原文 PDF",
    created_at: NOW, submitted_at: NOW, reviewed_at: null, reviewed_by: null,
    applied_at: null,
    items: [{
      id: "change-resource-item", position: 0, operation: "resource.acquire",
      target_type: "bibliographic_item", target_id: "item-1", base_revision: "3",
      payload: { request: { url: "https://example.test/fulltext.pdf", filename: "verified-fulltext.pdf", attachment_type: "fulltext", language_mode: "original", origin: "publisher", preferred_for: ["reading"] } },
      evidence: [{ source: "publisher", locator: "full text", url: "https://example.test/fulltext.pdf", quote: null, metadata: { captured_at: NOW } }],
      rationale: "出版者页面提供可核验的 HTTPS 原文地址", status: "proposed", result: null,
      error_code: null, error_message: null, created_at: NOW, reviewed_at: null, applied_at: null,
    }],
  };
}

function recoverableTransfer(): TransferPreview {
  return {
    id: "transfer-1",
    direction: "import",
    library: { kind: "groups", id: "42" },
    project_id: "project-1",
    created_at: NOW,
    expires_at: "2026-07-23T08:00:00Z",
    preview_hash: "d".repeat(64),
    state: "recoverable",
    summary: { total: 1, new: 0, update: 0, unchanged: 0, conflict: 1, blocked: 0 },
    resolutions: [{ conflict_id: "zotero-conflict-1", choice: "target", manual_changes: null, resolved_at: NOW }],
    items: [{
      item_id: "item-1",
      display_title: "Semantic Reading for Long Scientific Papers",
      action: "conflict",
      differences: [{ field: "title", source: "Zotero title", target: item().title }],
      conflicts: [{ id: "zotero-conflict-1", item_id: "item-1", kind: "field_conflict", message: "标题在两边都发生了变化", fields: ["title"] }],
      blocked_reason: null,
    }],
    receipt: {
      id: "receipt-1",
      preview_id: "transfer-1",
      preview_hash: "d".repeat(64),
      status: "applying",
      started_at: NOW,
      finished_at: null,
      items: [{ item_id: "item-1", planned_action: "conflict", outcome: "applying", external_key: "ABCD1234", external_version: 7, message: null }],
    },
  };
}

function preferences() {
  return {
    revision: 4,
    reader: { target_language: "zh-CN", default_mode: "bilingual", default_panel: "structured", font_family: "serif", font_size: "medium", line_height: "standard", measure: "balanced", density: "comfortable", flow: "continuous", columns: "auto", theme: "dark", show_outline: true, restore_position: true, large_touch_targets: true, reduce_motion: true },
    bilingual: { layout: "side_by_side", highlight_terms: true, synchronize_blocks: true },
    pdf: { color_mode: "original", default_zoom: "page_width", toolbar_density: "comfortable", restore_position: true },
    translation: { provider: "deepseek", model: "deepseek-v4-flash", style: "faithful_academic", batching: "whole_with_fallback", glossary: [{ source_term: "semantic block", translated_term: "语义块" }], retranslate_scope: "changed" },
    agent: { default_runtime: "codex", model: null, reasoning_effort: "high", enabled_capabilities: ["catalog_read", "candidate_propose", "metadata_propose", "resource_propose", "zotero_conflict_propose", "web_search"], context_summary: "balanced" },
    tasks: { notify_on_success: true, notify_on_failure: true, auto_open_result: false, max_concurrent_jobs: 2 }, updated_at: NOW,
  };
}

function documentBlocks(total = 240) {
  const headings = new Set([0, 40, 100, 180]);
  const blocks = Array.from({ length: total }, (_, index) => {
    const heading = headings.has(index);
    const source = heading ? ["Abstract", "Methods", "Results", "Limitations"][Array.from(headings).indexOf(index)] : `Paragraph ${index + 1} explains a stable semantic reading block and its evidence.`;
    return {
      id: `block-${index}`, document_id: "document-1", parent_id: null, ordinal: index,
      kind: heading ? (index === 0 ? "title" : "heading") : "paragraph",
      semantic_role: heading ? "other" : index < 100 ? "method" : index < 180 ? "result" : "limitation",
      source_text: source, source_sha256: "a".repeat(64), page_start: Math.floor(index / 10) + 1,
      page_end: Math.floor(index / 10) + 1, anchor: { type: "pdf_bbox", page: Math.floor(index / 10) + 1, bbox: { x: 10, y: 20, x2: 500, y2: 60 } },
      section_path: heading ? [] : [index < 100 ? "Methods" : index < 180 ? "Results" : "Limitations"], created_at: NOW,
      translation: { id: `translation-${index}`, block_id: `block-${index}`, target_language: "zh-CN", translated_text: heading ? `结构：${source}` : `第 ${index + 1} 段说明稳定语义块、证据与阅读节奏。`, source_sha256: "a".repeat(64), provider: "deepseek", model: "deepseek-v4-flash", prompt_version: "v1", batch_id: "job-success", validation_status: "verified", created_by_job_id: "job-success", created_at: NOW },
    };
  });
  return { document_id: "document-1", offset: 0, limit: 1000, total, items: blocks };
}

async function mockApi(page: Page, state: MockState) {
  await page.route(/^http:\/\/127\.0\.0\.1:4173\/api\//, async (route) => handleApi(route, state));
}

async function handleApi(route: Route, state: MockState) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const method = request.method();
  const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  const page = (items: unknown[], defaultLimit = 200) => {
    const limit = Number(url.searchParams.get("limit") ?? defaultLimit);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  };
  if (path === "/api/device-access/status") return json({ lan_enabled: false, local_request: true, authenticated: true, cookie_secure: false, session: null });
  if (path === "/api/workspace") return json({ generated_at: NOW, contract_version: "4.0", schema_version: 4, counts: { works: 1, attachments: state.attachments.length }, projects: [{ id: "project-1", name: "语义阅读研究", description: "平板文献工作流", item_count: 1, candidate_count: state.candidates.length, status_counts: { discovered: state.candidates.length, included: 1 }, updated_at: NOW }], capabilities: {} });
  if (path === "/api/projects" && method === "GET") return json([{ id: "project-1", name: "语义阅读研究", description: "平板文献工作流", work_count: 1, candidate_count: state.candidates.length, status_counts: { discovered: 0, included: 1 }, created_at: NOW, updated_at: NOW }]);
  if (path === "/api/projects/project-1") return json({ id: "project-1", name: "语义阅读研究", description: "平板文献工作流", work_count: 1, candidate_count: state.candidates.length, status_counts: { discovered: 0, included: 1 }, created_at: NOW, updated_at: NOW });
  if (path === "/api/projects/project-1/candidates") {
    const matches = url.searchParams.get("state")
      ? state.candidates.filter((entry) => entry.state === url.searchParams.get("state"))
      : state.candidates;
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 100);
    return json({ items: matches.slice(offset, offset + limit), total: matches.length, limit, offset });
  }
  if (path === "/api/projects/project-1/candidate-decisions" && method === "POST") {
    const body = request.postDataJSON() as { decisions: Array<{ candidate_id: string; decision: string; reason: string | null }> };
    state.decisions.push(...body.decisions);
    state.candidates = state.candidates.filter((entry) => !body.decisions.some((decision) => decision.candidate_id === entry.id));
    return json(body.decisions.map((decision) => ({ candidate: { ...candidate(Number(decision.candidate_id.split("-")[1])), state: decision.decision === "include" ? "promoted" : "dismissed", resolved_at: NOW }, project_item: decision.decision === "include" ? state.projectItem : null })));
  }
  if (path === "/api/projects/project-1/items") return json({ items: [state.projectItem], total: 1, limit: Number(url.searchParams.get("limit") ?? 100), offset: Number(url.searchParams.get("offset") ?? 0) });
  if (path === "/api/projects/project-1/works/work-1" && method === "PATCH") {
    const body = request.postDataJSON() as Partial<ReturnType<typeof projectItem>>;
    state.projectItem = { ...state.projectItem, ...body, updated_at: NOW };
    return json(state.projectItem);
  }
  if (path === "/api/items/item-1") return json(item());
  if (path === "/api/items/item-1/attachments") return json(state.attachments);
  if (path === "/api/items/item-1/history") return json({
    item_id: "item-1",
    revisions: [],
    field_sources: [],
    attachment_relations: [],
    audit_events: [],
  });
  if (path === "/api/audit-events") return json({
    items: [
      { id: "audit-1", occurred_at: NOW, actor_type: "system", actor_id: null, action: "legacy.imported", entity_type: "workspace", entity_id: "local", correlation_id: null, before: null, after: null, metadata: {} },
      { id: "audit-2", occurred_at: NOW, actor_type: "user", actor_id: null, action: "catalog.work_created", entity_type: "work", entity_id: "work-1", correlation_id: null, before: null, after: null, metadata: {} },
      { id: "audit-3", occurred_at: NOW, actor_type: "user", actor_id: null, action: "screening.project_deleted", entity_type: "project", entity_id: "project-1", correlation_id: null, before: null, after: null, metadata: {} },
    ],
    total: 3,
    limit: Number(url.searchParams.get("limit") ?? 20),
    offset: Number(url.searchParams.get("offset") ?? 0),
  });
  if (/^\/api\/attachments\/attachment-[12]\/content$/.test(path)) return route.fulfill({ status: 200, contentType: "application/pdf", body: Buffer.from(PDF, "base64") });
  if (path === "/api/items/item-1/documents") return json([{ id: "document-1", item_id: "item-1", source_attachment_id: "attachment-1", source_sha256: "b".repeat(64), extractor: "babeldoc+tex-structure", extractor_version: "1.0", structure_version: "v1", status: "ready", language: "en", page_count: 24, block_count: 240, structure_hash: "c".repeat(64), created_by_job_id: "job-extract", created_at: NOW, completed_at: NOW }]);
  if (path === "/api/documents/document-1/blocks") return json(documentBlocks());
  if (path === "/api/documents/document-1/glossary") return json([{ id: "glossary-1", document_id: "document-1", target_language: "zh-CN", source_term: "semantic block", translated_term: "语义块", note: null, batch_id: "job-success", created_at: NOW }]);
  if (path === "/api/projects/project-1/items/item-1/annotations") return json([{
    id: "annotation-stale",
    project_id: "project-1",
    item_id: "item-1",
    attachment_id: "attachment-1",
    block_id: "block-1",
    kind: "method",
    body: "这条方法批注需要重新定位。",
    quoted_text: null,
    source_sha256: "a".repeat(64),
    page_number: 1,
    anchor: { type: "pdf_bbox", page: 1 },
    anchor_status: "stale",
    tags: ["method"],
    created_at: NOW,
    updated_at: NOW,
  }]);
  if (path === "/api/projects/project-1/items/item-1/reading-state") return json({ attachment_id: "attachment-1", block_id: null, page_number: 1, progress: 0.08, project_id: "project-1", item_id: "item-1", bookmarks: [], updated_at: NOW });
  if (path === "/api/user-preferences" && method === "GET") {
    if (state.preferencesFailures > 0) { state.preferencesFailures -= 1; return json({ detail: "网络短暂断开，请重新读取" }, 503); }
    return json(preferences());
  }
  if (path === "/api/user-preferences" && method === "PUT") {
    const body = request.postDataJSON() as Record<string, unknown>;
    state.preferenceUpdates.push(body);
    return json({ ...preferences(), ...body, revision: 5, updated_at: NOW });
  }
  if (path === "/api/agent-task-definitions") return json([
    { id: "literature_search", label: "文献检索", description: "检索并把候选及来源证据放入项目。", scope_requirement: "project", web_search: true, scopes: ["catalog:read", "candidate:propose", "web:search"], tools: ["stage_candidate"], result_kind: "candidate", ready: true, missing_reason: null },
    { id: "metadata_enrichment", label: "元数据补全", description: "核验来源并提出字段级元数据修订。", scope_requirement: "item", web_search: true, scopes: ["catalog:read", "metadata:propose", "web:search"], tools: ["propose_metadata_patch"], result_kind: "change_set", ready: true, missing_reason: null },
    { id: "resource_acquisition", label: "资源获取", description: "查找资源并提出可审阅的 HTTPS 获取建议。", scope_requirement: "item", web_search: true, scopes: ["catalog:read", "resource:propose", "web:search"], tools: ["propose_resource_acquisition"], result_kind: "change_set", ready: true, missing_reason: null },
    { id: "conflict_resolution", label: "冲突分析", description: "分析固定 Zotero 预览中的冲突。", scope_requirement: "zotero_preview", web_search: false, scopes: ["zotero:conflict:propose"], tools: ["propose_zotero_conflict_resolution"], result_kind: "change_set", ready: true, missing_reason: null },
  ]);
  if (path === "/api/agent-runtimes") return json([
    { id: "codex", label: "Codex", transport: "app-server", ready: true, message: "Codex 应用服务已就绪。", version: "1", model: null, supports_resume: true },
    { id: "pi", label: "Pi", transport: "rpc", ready: true, message: "Pi RPC 已就绪。", version: "1", model: "deepseek-v4-flash", supports_resume: true },
    { id: "opencode", label: "OpenCode", transport: "acp", ready: true, message: "OpenCode ACP 已就绪。", version: "1", model: "deepseek-v4-flash", supports_resume: true },
    { id: "claude-code", label: "Claude Code", transport: "stream-json", ready: false, message: "尚未安装 Claude Code。", version: null, model: "deepseek-v4-flash", supports_resume: true },
  ]);
  if (path === "/api/agent-runs" && method === "POST") {
    const body = request.postDataJSON() as { task_kind: string; goal: string; runtime?: AgentRuntimeId };
    const run = agentRun(`run-${state.runs.length + 1}`, body.task_kind, body.goal, body.runtime ?? "codex");
    state.runs = [run, ...state.runs];
    if (body.task_kind === "literature_search") state.candidates = [candidate(0)];
    if (body.task_kind === "resource_acquisition") state.changes = [resourceChangeSet(run.id), ...state.changes];
    return json({ run, job_id: `agent-job-${run.id}` });
  }
  if (path === "/api/jobs") return json(page(state.jobs));
  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch) return json(state.jobs.find((entry) => entry.id === jobMatch[1]));
  const resumeMatch = path.match(/^\/api\/jobs\/([^/]+)\/resume$/);
  if (resumeMatch && method === "POST") {
    state.jobs = state.jobs.map((entry) => entry.id === resumeMatch[1] ? { ...entry, status: "queued", error_code: null, error_message: null, finished_at: null } : entry);
    return json(state.jobs.find((entry) => entry.id === resumeMatch[1]), 202);
  }
  if (path === "/api/agent-runs") return json(page(state.runs));
  const runMatch = path.match(/^\/api\/agent-runs\/([^/]+)$/);
  if (runMatch) return json(state.runs.find((entry) => entry.id === runMatch[1]));
  if (/^\/api\/agent-runs\/[^/]+\/approvals$/.test(path)) return json([]);
  if (/^\/api\/agent-runs\/[^/]+\/events$/.test(path)) return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ id: 1, run_id: path.split("/")[3], event_type: "run.completed", visibility: "public", payload: { message: "领域结果已经提交到工作台。" }, created_at: NOW })}\n\n` });
  if (path === "/api/change-sets") return json({ items: state.changes, total: state.changes.length });
  const reviewMatch = path.match(/^\/api\/change-sets\/([^/]+)\/review$/);
  if (reviewMatch && method === "POST") {
    const body = request.postDataJSON() as { decisions: Array<{ change_item_id: string; decision: "approve" | "reject" }> };
    const index = state.changes.findIndex((entry) => entry.id === reviewMatch[1]);
    const current = state.changes[index]!;
    const decisions = new Map(body.decisions.map((entry) => [entry.change_item_id, entry.decision]));
    const updated: ChangeSet = { ...current, status: "submitted", reviewed_at: NOW, items: current.items.map((entry) => ({ ...entry, status: decisions.get(entry.id) === "approve" ? "approved" : decisions.get(entry.id) === "reject" ? "rejected" : entry.status })) };
    state.changes[index] = updated;
    return json(updated);
  }
  const applyMatch = path.match(/^\/api\/change-sets\/([^/]+)\/apply$/);
  if (applyMatch && method === "POST") {
    const index = state.changes.findIndex((entry) => entry.id === applyMatch[1]);
    const current = state.changes[index]!;
    const resource = current.kind === "resource_acquisition";
    if (resource) {
      state.jobs = [successfulResourceJob(), ...state.jobs];
      if (!state.attachments.some((entry) => entry.id === "attachment-2")) state.attachments.push(attachment("attachment-2", "verified-fulltext.pdf"));
    }
    const result: ChangeSet["items"][number]["result"] = resource
      ? { job_id: "job-resource", job_status: "succeeded" }
      : { revision: 4 };
    const updated: ChangeSet = { ...current, status: "applied", applied_at: NOW, items: current.items.map((entry) => ({ ...entry, status: "applied", result })) };
    state.changes[index] = updated;
    return json(updated);
  }
  if (path === "/api/jobs/job-1/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ id: 1, job_id: "job-1", event_type: "job.failed", level: "error", payload: { code: "provider_unavailable", message: "翻译服务暂时不可用", retryable: true, automatic_retry: false, attempt: 3, max_attempts: 3 }, created_at: NOW })}\n\n` });
  if (path === "/api/jobs/job-resource/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ id: 2, job_id: "job-resource", event_type: "job.succeeded", level: "info", payload: { summary: "原文已经验证并登记", products: [{ type: "attachment", id: "attachment-2", role: "original", href: "/projects/project-1/items/item-1/read/attachment-2?panel=pdf" }] }, created_at: NOW })}\n\n` });
  if (path === "/api/items/item-1/attachments/download" && method === "POST") {
    const direct = runningResourceJob();
    state.jobs = [direct, ...state.jobs];
    return json(direct, 202);
  }
  if (path === "/api/jobs/job-direct/events") {
    if (!state.attachments.some((entry) => entry.id === "attachment-direct")) {
      state.attachments.push(attachment("attachment-direct", "event-refreshed.pdf"));
    }
    state.jobs = state.jobs.map((entry) => entry.id === "job-direct" ? { ...entry, status: "succeeded", finished_at: NOW } : entry);
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ id: 3, job_id: "job-direct", event_type: "job.succeeded", level: "info", payload: { summary: "原文已经验证并登记", products: [{ type: "attachment", id: "attachment-direct", role: "output", href: "/projects/project-1/items/item-1/read/attachment-direct?panel=pdf" }] }, created_at: NOW })}\n\n` });
  }
  if (path === "/api/zotero/status") return json({
    local: { available: true, read_only: true, message: "本机 Zotero 可读取" },
    web: { available: true, read_only: false, message: "Web API 可读写" },
    import_available: true,
    export_available: true,
  });
  if (path === "/api/zotero/transfers/transfer-1" && method === "GET") {
    return json(state.transfer);
  }
  if (path === "/api/zotero/transfers/transfer-1/execute" && method === "POST") {
    const receipt: TransferReceipt = {
      id: "receipt-1",
      preview_id: "transfer-1",
      preview_hash: "d".repeat(64),
      status: "succeeded",
      started_at: NOW,
      finished_at: NOW,
      items: [{ item_id: "item-1", planned_action: "conflict", outcome: "updated", external_key: "ABCD1234", external_version: 8, message: null }],
    };
    if (state.transfer) state.transfer = { ...state.transfer, state: "succeeded", receipt };
    return json(receipt);
  }
  if (path === "/api/device-access/sessions") return json([]);
  if (path === "/api/tools") return json([{ name: "pdf2zh", label: "PDF2zh / BabelDOC", description: "结构提取、OCR 与兼容 PDF 输出", status: "ready", version: "2.9.0", message: "固定版本已验证", job_id: null, updated_at: NOW }, { name: "tex", label: "TeX Live", description: "编译论文源码", status: "ready", version: "2026", message: "可用", job_id: null, updated_at: NOW }]);
  if (path === "/api/snapshots") return json({
    snapshots: [{
      filename: "workspace-20260722-080000.zip",
      size: 4096,
      created_at: NOW,
      download_url: "/api/snapshots/workspace-20260722-080000.zip",
    }],
    active_jobs: 0,
  });
  return json({ detail: `Unhandled mock endpoint: ${method} ${path}` }, 404);
}

function newState(count = 3): MockState {
  return {
    candidates: Array.from({ length: count }, (_, index) => candidate(index)),
    decisions: [], changes: [changeSet()], jobs: [job()], runs: [],
    projectItem: projectItem(), attachments: [attachment()], preferencesFailures: 0, preferenceUpdates: [],
    transfer: null,
  };
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

test("complete touch workflow reaches a verified resource from discovery", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 1366 });
  const state = newState(0);
  state.changes = [];
  state.jobs = [];
  await mockApi(page, state);
  await page.goto("/");

  const globalLauncher = page.locator(".agent-launcher").first();
  await globalLauncher.getByPlaceholder(/检索最近两年/).fill("检索结构化论文阅读界面的最新研究，并保存来源证据。");
  await globalLauncher.getByLabel("任务类型").selectOption("literature_search");
  await globalLauncher.getByRole("button", { name: "创建独立运行" }).tap();
  await expect(page).toHaveURL(/\/agent-runs\/run-1$/);
  await expect(page.getByText("已暂存 1 条带来源证据的候选。")).toBeVisible();

  await page.getByRole("button", { name: "打开导航" }).tap();
  await page.locator(".project-link").filter({ hasText: "语义阅读研究" }).tap();
  await expect(page.getByRole("heading", { name: "等待你的判断" })).toBeVisible();
  await page.locator(".candidate-row-main").filter({ hasText: "Traceable candidate 001" }).tap();
  await page.getByPlaceholder("记录收录或排除的理由").fill("来源可核验，直接回答当前项目问题。");
  await page.getByRole("button", { name: "收入项目" }).tap();
  await expect(page).toHaveURL(/\/projects\/project-1\/items\/item-1\/read\/attachment-1$/);

  await page.getByRole("button", { name: "信息" }).tap();
  await page.getByText("来源与修改历史").tap();
  await expect(page.getByText("这条文献尚无独立字段来源记录。")).toBeVisible();
  await page.getByLabel("项目摘要").fill("用于验证完整的结构化阅读工作流。");
  await page.getByLabel("相关性").fill("与项目目标直接相关。");
  await page.getByLabel("主要贡献").fill("稳定语义块\n触屏阅读节奏");
  await page.getByLabel("阅读重点").fill("方法\n局限");
  await page.getByRole("button", { name: "保存项目判断" }).tap();
  await expect(page.getByRole("status")).toHaveText("项目判断已保存");

  const itemLauncher = page.locator(".agent-launcher--item");
  await expect(itemLauncher.getByText("项目与文献标识由页面固定，不能跨作用域提交。")).toBeVisible();
  await itemLauncher.getByLabel("任务类型").selectOption("resource_acquisition");
  await itemLauncher.getByPlaceholder(/核对出版者页面/).fill("查找出版者原文并提交可审阅的 HTTPS 获取建议。");
  await itemLauncher.getByRole("button", { name: "创建独立运行" }).tap();
  await expect(page).toHaveURL(/\/agent-runs\/run-2$/);
  await expect(page.getByText("已提交资源获取变更建议。")).toBeVisible();

  await page.getByRole("link", { name: "返回任务中心" }).tap();
  await expect(page.getByRole("heading", { name: "获取出版者原文 PDF" })).toBeVisible();
  await page.getByRole("button", { name: "批准" }).tap();
  await page.getByRole("button", { name: "应用 1 项" }).tap();
  await page.getByRole("button", { name: /后台任务/ }).tap();
  await expect(page.getByRole("heading", { name: "获取文献资源" })).toBeVisible();
  await page.getByRole("link", { name: "打开输出附件" }).tap();
  await expect(page).toHaveURL(/\/read\/attachment-2\?panel=pdf$/);
  await page.getByRole("button", { name: "信息" }).tap();
  await expect(page.locator(".attachment-list button.active")).toContainText("verified-fulltext.pdf");

  expect(state.decisions).toEqual([
    expect.objectContaining({ candidate_id: "candidate-0", decision: "include" }),
  ]);
  expect(state.projectItem.summary).toBe("用于验证完整的结构化阅读工作流。");
  expect(state.runs.map((run) => run.task_kind)).toEqual(["resource_acquisition", "literature_search"]);
  expect(state.jobs.map((entry) => entry.id)).toEqual(["job-resource"]);
  await expectNoHorizontalOverflow(page);
});

test("agent runtime status, defaults and task launches stay explicit", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  const state = newState(0);
  await mockApi(page, state);

  await page.goto("/settings");
  await page.getByRole("button", { name: "智能体", exact: true }).tap();
  const settingsPicker = page.locator(".preferences-panel .agent-runtime-picker");
  await expect(settingsPicker.getByRole("radio", { name: /Codex/ })).toBeChecked();
  await expect(settingsPicker.getByRole("radio", { name: /Claude Code/ })).toBeDisabled();
  await expect(settingsPicker).toContainText("固定模型 · DeepSeek V4 Flash");
  await settingsPicker.locator(".runtime-option").filter({ hasText: "OpenCode" }).tap();
  await page.getByRole("button", { name: "保存全部设置" }).tap();
  await expect.poll(() => state.preferenceUpdates.length).toBe(1);
  expect(state.preferenceUpdates[0]?.agent).toEqual(expect.objectContaining({ default_runtime: "opencode" }));

  await page.goto("/");
  const launcher = page.locator(".agent-launcher").first();
  await launcher.locator(".runtime-option").filter({ hasText: "Pi" }).tap();
  await launcher.getByPlaceholder(/检索最近两年/).fill("用 Pi 检索可审计的文献来源。");
  await launcher.getByRole("button", { name: "创建独立运行" }).tap();
  await expect(page).toHaveURL(/\/agent-runs\/run-1$/);
  expect(state.runs[0]?.runtime).toBe("pi");
  await expect(page.locator(".timeline-runtime")).toContainText("Pi");
  await expect(page.locator(".timeline-meta")).toContainText("deepseek-v4-flash");
});

test("item resource task refreshes attachments from its real event contract", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  const state = newState(0);
  await mockApi(page, state);
  await page.goto("/projects/project-1/items/item-1/read/attachment-1?panel=pdf");

  await expect(page.getByRole("link", { name: "下载 PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: "全屏阅读" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF 批注，共 1 条" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const compactVersionTargets = await page
    .locator(".toolbar-group--versions button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }),
    );
  expect(
    compactVersionTargets.every(
      ({ width, height }) => width >= 44 && height >= 44,
    ),
  ).toBe(true);
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.getByRole("button", { name: "信息" }).tap();
  await page.getByText("从 HTTPS 获取", { exact: true }).tap();
  await page.getByPlaceholder("https://…").fill("https://example.test/event-refreshed.pdf");
  await page.getByPlaceholder("可选文件名").fill("event-refreshed.pdf");
  await page.getByRole("button", { name: "创建获取任务" }).tap();

  await expect(page.getByText("任务已完成，附件列表已自动更新。")).toBeVisible();
  await expect(page.locator(".attachment-list")).toContainText("event-refreshed.pdf");
  const tracker = page.locator(".resource-job").filter({ hasText: "HTTPS 获取" });
  await expect(tracker).toContainText("已完成");
  await tracker.getByRole("link", { name: "查看任务" }).tap();
  await expect(page).toHaveURL(/\/tasks\?job=job-direct$/);
  await page.getByRole("link", { name: "打开输出附件" }).tap();
  await expect(page).toHaveURL(/\/projects\/project-1\/items\/item-1\/read\/attachment-direct\?panel=pdf$/);
  await page.getByRole("button", { name: "信息" }).tap();
  await expect(page.locator(".attachment-list button.active")).toContainText("event-refreshed.pdf");
  await expectNoHorizontalOverflow(page);
});

test("large candidate inbox supports touch, batch reasons, keyboard and portrait layout", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  const state = newState(150);
  await mockApi(page, state);
  await page.goto("/projects/project-1");
  await expect(page.getByRole("heading", { name: "等待你的判断" })).toBeVisible();
  const projectTabs = await page.locator(".page-tabs button").evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }));
  expect(projectTabs.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
  await page.getByRole("button", { name: "选择 Traceable candidate 001" }).tap();
  await page.getByRole("button", { name: "选择 Traceable candidate 002" }).tap();
  await page.locator(".candidate-row-main").filter({ hasText: "Traceable candidate 001" }).tap();
  await page.getByPlaceholder("记录收录或排除的理由").fill("第一条来自权威来源");
  await page.locator(".candidate-row-main").filter({ hasText: "Traceable candidate 002" }).tap();
  await page.getByPlaceholder("记录收录或排除的理由").fill("第二条用于方法比较");
  await page.getByRole("button", { name: "批量收录" }).tap();
  await expect.poll(() => state.decisions.length).toBe(2);
  expect(state.decisions).toEqual(expect.arrayContaining([
    expect.objectContaining({ candidate_id: "candidate-0", reason: "第一条来自权威来源" }),
    expect.objectContaining({ candidate_id: "candidate-1", reason: "第二条用于方法比较" }),
  ]));
  const workspace = page.getByLabel("候选审阅工作区，方向键或 J K 切换，I 收录，X 排除");
  await workspace.focus();
  await workspace.press("j");
  await page.locator(".candidate-row-main").filter({ hasText: "Traceable candidate 004" }).tap();
  await expect(page.getByRole("heading", { name: "可追踪候选 4", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭候选详情" })).toBeVisible();
  await page.evaluate(() => (globalThis.document.activeElement as HTMLElement | null)?.blur());
  await page.locator(".research-main").evaluate((element) => { element.scrollTop = 0; });
  await page.waitForTimeout(100);
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("candidate-inbox-tablet-portrait.png");
});

test("change approval and exhausted job failure remain actionable on touch landscape", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const state = newState();
  await mockApi(page, state);
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "补全期刊名与出版年份" })).toBeVisible();
  await page.getByRole("button", { name: "批准" }).tap();
  await expect(page.getByRole("button", { name: "应用 1 项" })).toBeVisible();
  await page.getByRole("button", { name: "应用 1 项" }).tap();
  await page.getByRole("button", { name: /后台任务/ }).tap();
  await expect(page.getByText("自动重试已用尽，可以恢复任务")).toBeVisible();
  await expect(page.locator(".job-retry-guidance > span")).toHaveText("网络或临时服务");
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("task-recovery-tablet-landscape.png");
  await page.getByRole("button", { name: "从失败点恢复" }).tap();
  await expect(page.locator(".task-detail-heading .run-status")).toHaveText("等待执行");
  expect(state.jobs.find((entry) => entry.id === "job-1")?.status).toBe("queued");
});

test("long semantic paper remains searchable and usable above a virtual keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const state = newState();
  await mockApi(page, state);
  await page.goto("/projects/project-1/items/item-1/read/attachment-1?panel=semantic&block=block-239&page=24");
  await expect(page.locator(".semantic-toolbar__status")).toHaveText("240 块 · 240 已译 · 8%");
  await expect(page.getByText("Paragraph 240 explains a stable semantic reading block and its evidence.")).toBeInViewport();
  await page.getByRole("button", { name: /笔记 1/ }).tap();
  const staleAnchor = page.locator(".reading-memory-anchor-stale > button:first-child");
  await expect(staleAnchor).toBeDisabled();
  await expect(staleAnchor).toContainText("源文已变化，锚点失效");
  await page.getByRole("button", { name: "关闭阅读工作区" }).tap();
  await page.getByRole("button", { name: "分屏" }).tap();
  await expect(page.getByRole("region", { name: "PDF 版面" })).toBeVisible();
  await expect(page.getByRole("region", { name: "结构化双语内容" })).toBeVisible();
  const divider = page.getByRole("separator", { name: "调整分屏比例，当前 PDF 50%" });
  await expect(divider).toBeVisible();
  await divider.press("ArrowLeft");
  await expect(page.getByRole("separator", { name: "调整分屏比例，当前 PDF 45%" })).toBeVisible();
  await page.getByRole("button", { name: "结构阅读" }).tap();
  await page.setViewportSize({ width: 768, height: 1024 });
  const search = page.getByLabel("全文搜索");
  await search.tap();
  await search.fill("Paragraph 240");
  await expect(page.getByText("Paragraph 240 explains a stable semantic reading block and its evidence.")).toBeVisible();
  await page.setViewportSize({ width: 768, height: 640 });
  await expect(search).toBeInViewport();
  const touchTargets = await page.locator(".semantic-toolbar button").evaluateAll((buttons) => buttons.map((button) => { const box = button.getBoundingClientRect(); return { width: box.width, height: box.height }; }));
  expect(touchTargets.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("semantic-reader-virtual-keyboard.png");
});

test("settings recover locally after a transient preferences outage", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  const state = newState();
  await mockApi(page, state);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "从候选到阅读，保持每一步清晰" })).toBeVisible();
  // One request may come from the global job-notification poller while the
  // StrictMode-mounted settings resource issues its two initial reads.
  state.preferencesFailures = 3;
  await page.getByRole("button", { name: "打开导航" }).tap();
  await page.getByRole("link", { name: "设置" }).tap();
  await expect(page.getByText("网络短暂断开，请重新读取")).toBeVisible();
  await page.getByRole("button", { name: "重新读取" }).tap();
  await expect(page.getByRole("navigation", { name: "设置分区" })).toBeVisible();
  await page.getByRole("button", { name: "翻译" }).tap();
  await expect(page.getByLabel("重新翻译范围")).toHaveValue("changed");
  await page.getByLabel("术语表").tap();
  await page.setViewportSize({ width: 768, height: 640 });
  await expect(page.getByLabel("术语表")).toBeInViewport();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("settings-recovered-tablet.png");
});

test("destructive snapshot controls keep tablet-sized touch targets", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await mockApi(page, newState());
  await page.goto("/settings");
  await expect(page.getByText("导入旧工作区")).toBeVisible();
  await expect(page.getByText("文献入库")).toBeVisible();
  await expect(page.getByText("删除筛选项目")).toBeVisible();
  const restore = page.locator(".snapshot-restore");
  await expect(restore).toBeVisible();
  await restore.scrollIntoViewIfNeeded();
  const touchTargets = await restore.locator("input, button").evaluateAll((controls) => controls.map((control) => {
    const box = control.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }));
  expect(touchTargets.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
  await expectNoHorizontalOverflow(page);
});

test("phone-width navigation and user workflows remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = newState(0);
  await mockApi(page, state);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "从候选到阅读，保持每一步清晰" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "打开导航" }).tap();
  const navigationTargets = await page.locator(".primary-nav-link").evaluateAll((links) => links.map((link) => {
    const box = link.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }));
  expect(navigationTargets.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
  await page.locator(".project-link").filter({ hasText: "语义阅读研究" }).tap();

  await expect(page.locator(".page-tabs button.active")).toContainText("项目文献");
  await expect(page.getByText("Semantic Reading for Long Scientific Papers")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "继续运行，审阅结果" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto("/route-that-does-not-exist");
  await expect(page.getByRole("heading", { name: "这里没有可打开的内容" })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回工作台" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("Zotero transfer scope and checkpoint survive a page refresh", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const state = newState();
  state.transfer = recoverableTransfer();
  await mockApi(page, state);
  await page.goto("/integrations?transfer=transfer-1");

  await expect(page.getByTitle("已连接 Zotero Desktop 本机接口")).toBeVisible();
  await expect(
    page.getByTitle("Zotero Web API 已配置，可用于导入与导出"),
  ).toBeVisible();
  await expect(page.locator(".transfer-state")).toHaveText("可从断点继续");
  await expect(page.getByLabel("库类型")).toHaveValue("groups");
  await expect(page.getByLabel("库 ID")).toHaveValue("42");
  await expect(page.locator(".zotero-fields label").filter({ hasText: "项目" }).locator("select")).toHaveValue("project-1");
  await expect(page.getByText("已保留当前项目版本")).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/integrations\?transfer=transfer-1$/);
  await expect(page.locator(".transfer-state")).toHaveText("可从断点继续");
  await expect(page.getByText("已保留当前项目版本")).toBeVisible();
  await page.getByLabel(/上次执行已中断/).check();
  await page.getByRole("button", { name: "从断点继续迁移" }).tap();
  await expect(page.locator(".transfer-state")).toHaveText("迁移完成");
  expect(state.transfer?.state).toBe("succeeded");
  await expectNoHorizontalOverflow(page);
});
