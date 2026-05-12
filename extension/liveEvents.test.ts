import { describe, expect, it } from "vitest";

import { mergeCaptionEvent, parseSseChunk } from "./liveEvents";
import type { LiveCaptionEvent } from "./types";
import { normalizeYouTubeVideoId } from "./youtube";

const baseCaption: LiveCaptionEvent = {
  type: "caption",
  session_id: "session-1",
  event_id: "evt-1",
  period: 1,
  clock: "11:55",
  event_type: "made_shot",
  text: "Initial caption.",
  source: "feed",
  confidence: 0.86,
  model_name: "template-live",
  replay_time_sec: 5,
};

describe("extension live event helpers", () => {
  it("merges caption updates by event id", () => {
    const update: LiveCaptionEvent = {
      ...baseCaption,
      type: "caption_update",
      text: "Updated caption.",
      caption_stage: "enriched",
    };

    expect(mergeCaptionEvent([baseCaption], update)).toEqual([
      expect.objectContaining({ event_id: "evt-1", text: "Updated caption.", caption_stage: "enriched" }),
    ]);
  });

  it("parses streamed SSE chunks and preserves partial data", () => {
    const payload = JSON.stringify({ type: "tick", session_id: "session-1", period: 1, clock: "11:55" });
    const parsed = parseSseChunk(`event: tick\ndata: ${payload}\n\nevent: caption\ndata: {"type"`);

    expect(parsed.events).toEqual([expect.objectContaining({ type: "tick", clock: "11:55" })]);
    expect(parsed.rest).toBe('event: caption\ndata: {"type"');
  });

  it("normalizes YouTube watch and live URLs", () => {
    expect(normalizeYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(normalizeYouTubeVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(normalizeYouTubeVideoId("https://example.test/watch?v=dQw4w9WgXcQ")).toBeNull();
  });
});
