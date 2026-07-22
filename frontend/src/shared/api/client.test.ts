import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("domain API client", () => {
  it("creates projects through the project command path", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"id":"project-1"}', { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await api.createProject({ name: "Agent memory", description: "Recent literature" });

    expect(fetch).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ method: "POST" }));
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ name: "Agent memory", description: "Recent literature" });
  });

  it("submits explicit candidate decisions through one project command", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await api.decideCandidates("project-1", [{ candidate_id: "candidate-1", decision: "include", reason: "relevant" }]);

    expect(fetch).toHaveBeenCalledWith("/api/projects/project-1/candidate-decisions", expect.objectContaining({ method: "POST" }));
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ decisions: [{ candidate_id: "candidate-1", decision: "include", reason: "relevant" }] });
  });

  it("loads every project item page and filters pending candidate states on the server", async () => {
    const fetch = vi.fn().mockImplementation((path: string) => {
      const url = new URL(path, "https://local.test");
      if (url.pathname.endsWith("/items")) {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const count = offset === 0 ? 500 : 1;
        return Promise.resolve(new Response(JSON.stringify({
          items: Array.from({ length: count }, (_, index) => ({ id: `item-${offset + index}` })),
          total: 501,
          limit: 500,
          offset,
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      const state = url.searchParams.get("state");
      return Promise.resolve(new Response(JSON.stringify({
        items: [{
          id: `candidate-${state}`,
          rank: state === "staged" ? 2 : 1,
          created_at: state === "staged" ? "2026-01-02" : "2026-01-01",
        }],
        total: 1,
        limit: 500,
        offset: 0,
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetch);

    const items = await api.projectItems("project-1", "included");
    const candidates = await api.candidates("project-1", ["staged", "matched"]);

    expect(items).toHaveLength(501);
    expect(candidates.map((entry) => entry.id)).toEqual(["candidate-matched", "candidate-staged"]);
    expect(fetch.mock.calls.map(([path]) => String(path))).toContain(
      "/api/projects/project-1/items?status=included&limit=500&offset=500",
    );
    expect(fetch.mock.calls.map(([path]) => String(path))).toEqual(expect.arrayContaining([
      "/api/projects/project-1/candidates?state=staged&limit=500",
      "/api/projects/project-1/candidates?state=matched&limit=500",
    ]));
  });

  it("loads the complete durable job and agent run histories", async () => {
    const fetch = vi.fn().mockImplementation((path: string) => {
      const url = new URL(path, "https://local.test");
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const count = offset === 0 ? 500 : 1;
      const prefix = url.pathname.endsWith("/jobs") ? "job" : "run";
      return Promise.resolve(new Response(JSON.stringify({
        items: Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${offset + index}` })),
        total: 501,
        limit: 500,
        offset,
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetch);

    const [jobs, runs] = await Promise.all([api.jobs(), api.agentRuns()]);

    expect(jobs).toHaveLength(501);
    expect(runs).toHaveLength(501);
    expect(fetch.mock.calls.map(([path]) => String(path))).toEqual(expect.arrayContaining([
      "/api/jobs?limit=500&offset=500",
      "/api/agent-runs?limit=500&offset=500",
    ]));
  });

  it("always binds Zotero execution to an explicitly confirmed preview hash", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"id":"receipt"}', { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await api.executeZoteroTransfer("preview-1", "a".repeat(64));

    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ confirmed: true, expected_preview_hash: "a".repeat(64) });
  });

  it("keeps task event stream URLs centralized", () => {
    expect(api.jobEventsUrl("job-1", 19)).toBe("/api/jobs/job-1/events?after=19");
    expect(api.agentEventsUrl("run-1", 4)).toBe("/api/agent-runs/run-1/events?after=4");
  });

  it("does not expose generic job creation but can resume an audited job", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    expect(Object.hasOwn(api, "createJob")).toBe(false);
    await api.resumeJob("job-1");
    expect(fetch).toHaveBeenCalledWith("/api/jobs/job-1/resume", expect.objectContaining({ method: "POST" }));
  });

  it("sends the selected project with a literature search run", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"run":{"id":"run-1"},"job_id":"job-1"}', { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await api.createAgentRun({
      task_kind: "literature_search",
      goal: "Find recent memory papers",
      project_id: "project-1",
    });

    expect(fetch).toHaveBeenCalledWith("/api/agent-runs", expect.objectContaining({ method: "POST" }));
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      task_kind: "literature_search",
      goal: "Find recent memory papers",
      project_id: "project-1",
    });
  });

  it("uploads attachments as multipart data without forcing a JSON content type", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await api.uploadAttachment("item-1", new File(["pdf"], "paper.pdf", { type: "application/pdf" }), {
      attachment_type: "fulltext",
      language_mode: "original",
      origin: "user",
      preferred_for: ["reading", "pdf:original"],
    });

    expect(fetch).toHaveBeenCalledWith("/api/items/item-1/attachments", expect.objectContaining({ method: "POST" }));
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
    const body = init.body as FormData;
    expect(body.get("attachment_type")).toBe("fulltext");
    expect(body.getAll("preferred_for")).toEqual(["reading", "pdf:original"]);
  });

  it("routes attachment and tool actions through typed domain commands", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 202, headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetch);

    await api.acquireAttachment("item-1", {
      url: "https://example.test/paper.pdf",
      filename: "paper.pdf",
      attachment_type: "fulltext",
      language_mode: "original",
      origin: "preprint",
      preferred_for: ["reading"],
    }, "project-1");
    await api.compileAttachment("source-1", "src/main.tex", "project-1");
    await api.setAttachmentPreference("item-1", "reading", "pdf-1");
    await api.installTool("tex");

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/items/item-1/attachments/download?project_id=project-1",
      "/api/attachments/source-1/compile?project_id=project-1",
      "/api/items/item-1/attachment-preferences",
      "/api/tools/tex/install",
    ]);
    expect(JSON.parse(String((fetch.mock.calls[1]![1] as RequestInit).body))).toEqual({ main_tex: "src/main.tex" });
    expect(JSON.parse(String((fetch.mock.calls[2]![1] as RequestInit).body))).toEqual({ purpose: "reading", attachment_id: "pdf-1" });
  });

  it("routes semantic extraction and whole-document translation through document commands", async () => {
    const fetch = vi.fn().mockImplementation((path: string) => Promise.resolve(new Response(
      path.includes("/blocks")
        ? JSON.stringify({ document_id: "document-1", offset: 0, limit: 1000, total: 0, items: [] })
        : "{}",
      { status: path.includes("/blocks") ? 200 : 202, headers: { "Content-Type": "application/json" } },
    )));
    vi.stubGlobal("fetch", fetch);

    await api.extractDocument("attachment-1", "force");
    await api.documentBlocks("document-1", "zh-CN");
    await api.translateDocument("document-1", "zh-CN");

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/attachments/attachment-1/documents",
      "/api/documents/document-1/blocks?limit=1000&target_language=zh-CN",
      "/api/documents/document-1/translate",
    ]);
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body))).toEqual({ ocr_mode: "force" });
    expect(JSON.parse(String((fetch.mock.calls[2]![1] as RequestInit).body))).toEqual({ target_language: "zh-CN" });
  });

  it("loads every semantic block page before returning searchable document content", async () => {
    const page = (offset: number, count: number) => ({
      document_id: "document-1",
      offset,
      limit: 1000,
      total: 1002,
      items: Array.from({ length: count }, (_, index) => ({ id: `block-${offset + index}` })),
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page(0, 1000)), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page(1000, 2)), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    const result = await api.documentBlocks("document-1", "zh-CN");

    expect(result.items).toHaveLength(1002);
    expect(result.items.at(-1)).toEqual({ id: "block-1001" });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/documents/document-1/blocks?limit=1000&target_language=zh-CN",
      "/api/documents/document-1/blocks?limit=1000&offset=1000&target_language=zh-CN",
    ]);
  });

  it("routes reading state, bookmarks, annotations, and preferences through typed commands", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetch);

    await api.updateReadingState("project-1", "item-1", {
      attachment_id: "attachment-1",
      block_id: "block-1",
      page_number: 3,
      progress: 0.42,
    });
    await api.addReadingBookmark("project-1", "item-1", {
      block_id: "block-1",
      page_number: 3,
      label: "Method",
    });
    await api.createAnnotation("project-1", "item-1", {
      attachment_id: null,
      block_id: "block-1",
      kind: "method",
      body: "Important method",
      quoted_text: null,
      page_number: null,
      anchor: {},
      tags: ["method"],
    });
    await api.deleteAnnotation("annotation-1", "2026-07-22T00:00:00Z");
    await api.updateUserPreferences({
      expected_revision: 2,
      reader: {
        target_language: "zh-CN",
        default_mode: "bilingual",
        default_panel: "structured",
        font_family: "serif",
        font_size: "large",
        line_height: "standard",
        measure: "balanced",
        density: "comfortable",
        flow: "continuous",
        columns: "auto",
        theme: "dark",
        show_outline: true,
        restore_position: true,
        large_touch_targets: true,
        reduce_motion: false,
      },
      bilingual: { layout: "side_by_side", highlight_terms: true, synchronize_blocks: true },
      pdf: { color_mode: "original", default_zoom: "page_width", toolbar_density: "comfortable", restore_position: true },
      translation: { provider: "deepseek", model: "deepseek-v4-flash", style: "faithful_academic", batching: "whole_with_fallback", glossary: [], retranslate_scope: "changed" },
      agent: { model: null, reasoning_effort: "high", enabled_capabilities: ["catalog_read"], context_summary: "balanced" },
      tasks: { notify_on_success: true, notify_on_failure: true, auto_open_result: false, max_concurrent_jobs: 2 },
    });

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/projects/project-1/items/item-1/reading-state",
      "/api/projects/project-1/items/item-1/reading-state/bookmarks",
      "/api/projects/project-1/items/item-1/annotations",
      "/api/annotations/annotation-1?expected_updated_at=2026-07-22T00%3A00%3A00Z",
      "/api/user-preferences",
    ]);
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body))).toEqual({
      attachment_id: "attachment-1",
      block_id: "block-1",
      page_number: 3,
      progress: 0.42,
    });
    expect(JSON.parse(String((fetch.mock.calls[4]![1] as RequestInit).body)).expected_revision).toBe(2);
  });

  it("keeps device pairing secrets in request bodies and session cookies", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetch);

    await api.pairDevice({ code: "ABCD-EFGH", label: "Reading tablet" });
    await api.revokeDeviceSession("session-1");

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/device-access/pair",
      "/api/device-access/sessions/session-1",
    ]);
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain("ABCD-EFGH");
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body))).toEqual({
      code: "ABCD-EFGH",
      label: "Reading tablet",
    });
    expect((fetch.mock.calls[1]![1] as RequestInit).method).toBe("DELETE");
  });

  it("requires the caller to supply the exact snapshot restore confirmation", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 202, headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetch);

    await api.createSnapshot();
    await api.restoreSnapshot("research 1.researchpack", "research 1.researchpack");

    expect(fetch.mock.calls[0]?.[0]).toBe("/api/snapshots");
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/snapshots/research%201.researchpack/restore");
    const init = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ confirmation: "research 1.researchpack" });
  });

  it("persists an explicit Zotero conflict choice on the preview", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await api.resolveZoteroConflict("preview-1", "conflict-1", "target");

    expect(fetch).toHaveBeenCalledWith(
      "/api/zotero/transfers/preview-1/conflicts/conflict-1",
      expect.objectContaining({ method: "PUT" }),
    );
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ conflict_id: "conflict-1", choice: "target" });
  });
});
