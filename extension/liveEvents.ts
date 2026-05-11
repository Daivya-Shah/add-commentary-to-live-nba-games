import type { LiveCaptionEvent, LiveStreamEvent } from "./types";

export function mergeCaptionEvent(
  current: LiveCaptionEvent[],
  event: LiveCaptionEvent,
  limit = 30,
): LiveCaptionEvent[] {
  if (event.type === "caption_update") {
    const index = current.findIndex((caption) => caption.event_id === event.event_id);
    if (index >= 0) {
      const next = [...current];
      next[index] = { ...next[index], ...event };
      return next;
    }
  }
  return [event, ...current].slice(0, limit);
}

export function parseSseChunk(buffer: string): { events: LiveStreamEvent[]; rest: string } {
  const events: LiveStreamEvent[] = [];
  const parts = buffer.split(/\n\n/);
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const dataLines = part
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) continue;
    try {
      events.push(JSON.parse(dataLines.join("\n")) as LiveStreamEvent);
    } catch {
      // Ignore malformed keepalive or proxy-injected chunks.
    }
  }
  return { events, rest };
}

export function compactClock(event: LiveCaptionEvent): string {
  return `Q${event.period} ${event.clock}`;
}
