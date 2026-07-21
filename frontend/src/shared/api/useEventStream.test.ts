import { describe, expect, it } from "vitest";

import { extractSseEvents } from "./useEventStream";

describe("SSE parser", () => {
  it("parses named events, multiline data, heartbeats, and keeps an incomplete tail", () => {
    const parsed = extractSseEvents<{ id: number; message: string }>(
      ': heartbeat\n\nid: 1\nevent: tool.started\ndata: {"id":1,\ndata: "message":"running"}\n\nid: 2\ndata: {"id":2',
    );
    expect(parsed.events).toEqual([{ id: 1, message: "running" }]);
    expect(parsed.rest).toBe('id: 2\ndata: {"id":2');
  });
});
