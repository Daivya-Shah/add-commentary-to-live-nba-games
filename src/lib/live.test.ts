import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatLatency,
  formatReplayTime,
  normalizeYouTubeVideoId,
  searchLiveGames,
  startLiveSession,
  stopLiveSession,
  uploadLiveReplayFile,
} from "@/lib/live";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("live utilities", () => {
  it("formats live latency", () => {
    expect(formatLatency(420)).toBe("420 ms");
    expect(formatLatency(1420)).toBe("1.4 s");
  });

  it("formats replay time", () => {
    expect(formatReplayTime(0)).toBe("0:00");
    expect(formatReplayTime(125)).toBe("2:05");
  });

  it("normalizes common YouTube video URLs", () => {
    expect(normalizeYouTubeVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(normalizeYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=12")).toBe("dQw4w9WgXcQ");
    expect(normalizeYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(normalizeYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(normalizeYouTubeVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(normalizeYouTubeVideoId("https://example.test/video")).toBeNull();
  });

  it("uploads replay files to the local backend", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:8000/live/uploads?filename=wizards.mp4");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(File);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(
        JSON.stringify({
          upload_id: "abc",
          file_url: "http://127.0.0.1:8000/live/uploads/abc",
          filename: "wizards.mp4",
          size_bytes: 123,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const file = new File(["video"], "wizards.mp4", { type: "video/mp4" });
    await expect(uploadLiveReplayFile(file)).resolves.toMatchObject({
      file_url: "http://127.0.0.1:8000/live/uploads/abc",
      size_bytes: 123,
    });
  });

  it("treats already-expired live sessions as stopped", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:8000/live/sessions/missing/stop");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ detail: "Live session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(stopLiveSession("missing")).resolves.toBeUndefined();
  });

  it("searches live games with a client-side timeout signal", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/live/games/search?");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(
        JSON.stringify([
          {
            game_id: "0022300157",
            game_date: "2023-11-08",
            season: "2023-24",
            season_type: "Regular Season",
            matchup: "WAS @ CHA",
            team_abbreviation: "WAS",
            opponent_abbreviation: "CHA",
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(
      searchLiveGames({
        team: "WAS",
        opponent: "CHA",
        season: "2023-24",
        season_type: "Regular Season",
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject([{ game_id: "0022300157" }]);
  });

  it("uses sanitized live game search errors from the backend", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          detail: "NBA game search timed out. Enter the game ID manually or try again.",
        }),
        { status: 504, headers: { "Content-Type": "application/json" } },
      ),
    ) as typeof fetch;

    await expect(
      searchLiveGames({
        team: "WAS",
        opponent: "CHA",
        season: "2023-24",
        season_type: "Regular Season",
      }),
    ).rejects.toThrow("NBA game search timed out. Enter the game ID manually or try again.");
  });

  it("starts live sessions with a timeout signal", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:8000/live/sessions");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(
        JSON.stringify({
          session_id: "session-1",
          status: "ready",
          source_type: "replay_file",
          team_names: ["WAS", "CHA"],
          event_count: 1,
          warnings: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await expect(
      startLiveSession({
        file_url: "https://example.test/replay.mp4",
        nba_game_id: "0022300157",
        start_period: 1,
        start_clock: "12:00",
      }),
    ).resolves.toMatchObject({ session_id: "session-1" });
  });
});
