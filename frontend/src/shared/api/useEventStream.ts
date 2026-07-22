import { useEffect, useRef, useState } from "react";

export type StreamState = "idle" | "connecting" | "open" | "closed" | "error";

export function useEventStream<T extends { id: number }>(url: string | null) {
  const [events, setEvents] = useState<T[]>([]);
  const [state, setState] = useState<StreamState>(url ? "connecting" : "idle");
  const latestId = useRef(0);

  useEffect(() => {
    setEvents([]);
    latestId.current = 0;
    if (!url) {
      setState("idle");
      return;
    }
    const controller = new AbortController();
    setState("connecting");
    void runWithReconnect<T>(url, controller.signal, latestId, setState, (event) => {
        latestId.current = Math.max(latestId.current, event.id);
        setEvents((current) =>
          current.some((item) => item.id === event.id) ? current : [...current, event],
        );
        setState("open");
      });
    return () => controller.abort();
  }, [url]);

  return { events, state };
}

async function runWithReconnect<T extends { id: number }>(
  url: string,
  signal: AbortSignal,
  latestId: { current: number },
  setState: (state: StreamState) => void,
  onEvent: (event: T) => void,
) {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      await consumeSse<T>(url, signal, latestId.current, (event) => {
        attempt = 0;
        onEvent(event);
      });
      if (!signal.aborted) setState("closed");
      return;
    } catch {
      if (signal.aborted) return;
      setState("error");
      await abortableDelay(reconnectDelay(attempt), signal);
      if (signal.aborted) return;
      attempt += 1;
      setState("connecting");
    }
  }
}

export function reconnectDelay(attempt: number) {
  return Math.min(15_000, 500 * 2 ** Math.min(Math.max(attempt, 0), 5));
}

async function consumeSse<T>(
  url: string,
  signal: AbortSignal,
  after: number,
  onEvent: (event: T) => void,
) {
  const response = await fetch(withAfter(url, after), {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`事件流连接失败：${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
    const parsed = extractSseEvents<T>(buffer);
    buffer = parsed.rest;
    for (const event of parsed.events) onEvent(event);
    if (done) break;
  }
}

function withAfter(url: string, after: number) {
  if (!after) return url;
  if (/[?&]after=/.test(url)) return url.replace(/([?&])after=[^&]*/, `$1after=${after}`);
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}after=${after}`;
}

export function extractSseEvents<T>(buffer: string): { events: T[]; rest: string } {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: T[] = [];
  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) events.push(JSON.parse(data) as T);
  }
  return { events, rest };
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
