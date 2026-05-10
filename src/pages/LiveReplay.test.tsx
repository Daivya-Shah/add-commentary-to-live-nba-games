import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import LiveReplay from "@/pages/LiveReplay";

const originalFetch = global.fetch;
const originalEventSource = global.EventSource;

afterEach(() => {
  global.fetch = originalFetch;
  global.EventSource = originalEventSource;
  delete window.YT;
  delete window.onYouTubeIframeAPIReady;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("LiveReplay", () => {
  it("renders the setup controls", () => {
    render(
      <MemoryRouter>
        <LiveReplay />
      </MemoryRouter>,
    );

    expect(screen.getByText(/REPLAY,/)).toBeInTheDocument();
    expect(screen.getByText(/SEARCH BY MATCHUP/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /detect game/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/NBA game id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Start period/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Start clock/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Include extra player\/team knowledge/i)).not.toBeChecked();
    expect(screen.getByRole("button", { name: /START REPLAY/i })).toBeInTheDocument();
  });

  it("searches games and fills the selected game id", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/live/teams")) {
        return new Response(
          JSON.stringify([
            { team_id: "1610612764", name: "Washington Wizards", abbreviation: "WAS", city: "Washington" },
            { team_id: "1610612766", name: "Charlotte Hornets", abbreviation: "CHA", city: "Charlotte" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/live/games/search")) {
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
              home_team: "CHA",
              away_team: "WAS",
              team_score: 132,
              opponent_score: 116,
              score: "132-116",
              result: "W",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <LiveReplay />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(/^Team$/i), { target: { value: "WAS" } });
    fireEvent.change(screen.getByLabelText(/Opponent/i), { target: { value: "CHA" } });
    fireEvent.change(screen.getByLabelText(/NBA season/i), { target: { value: "2023-24" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    const result = await screen.findByText("0022300157");
    fireEvent.click(result.closest("button") as HTMLButtonElement);

    await waitFor(() => expect(screen.getByLabelText(/NBA game id/i)).toHaveValue("0022300157"));
    expect(screen.getByText(/SELECTED/i)).toBeInTheDocument();
  });

  it("starts from manual game setup and sends the optional knowledge flag", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    class FakeEventSource {
      onerror: (() => void) | null = null;
      addEventListener = vi.fn();
      close = vi.fn();
    }
    global.EventSource = FakeEventSource as unknown as typeof EventSource;

    let sessionBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/live/teams")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/live/sessions")) {
        sessionBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            session_id: "session-1",
            status: "ready",
            source_type: "replay_file",
            team_names: ["WAS", "CHA"],
            event_count: 12,
            warnings: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <LiveReplay />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /paste url/i }));
    fireEvent.change(screen.getByLabelText(/Replay video URL/i), { target: { value: "https://example.test/replay.mp4" } });
    fireEvent.change(screen.getByLabelText(/NBA game id/i), { target: { value: "0022300157" } });
    fireEvent.change(screen.getByLabelText(/Start clock/i), { target: { value: "11:42" } });
    fireEvent.click(screen.getByLabelText(/Include extra player\/team knowledge/i));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start replay/i }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() =>
      expect(sessionBody).toMatchObject({
        nba_game_id: "0022300157",
        start_period: 1,
        start_clock: "11:42",
        include_knowledge: true,
      }),
    );
  });

  it("shows upload and NBA feed phases while starting an uploaded replay", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:wizards") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    class FakeEventSource {
      onerror: (() => void) | null = null;
      addEventListener = vi.fn();
      close = vi.fn();
    }
    global.EventSource = FakeEventSource as unknown as typeof EventSource;

    let resolveUpload: ((response: Response) => void) | null = null;
    let resolveSession: ((response: Response) => void) | null = null;
    let sessionBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/live/teams")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/live/uploads")) {
        return new Promise<Response>((resolve) => {
          resolveUpload = resolve;
        });
      }
      if (url.endsWith("/live/sessions")) {
        sessionBody = JSON.parse(String(init?.body));
        return new Promise<Response>((resolve) => {
          resolveSession = resolve;
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <LiveReplay />
      </MemoryRouter>,
    );

    const file = new File(["video"], "wizards.mp4", { type: "video/mp4" });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText(/NBA game id/i), { target: { value: "0022300157" } });
    fireEvent.click(screen.getByRole("button", { name: /start replay/i }));

    expect(await screen.findByRole("button", { name: /uploading/i })).toBeInTheDocument();
    resolveUpload?.(
      new Response(
        JSON.stringify({
          upload_id: "abc",
          file_url: "http://127.0.0.1:8000/live/uploads/abc",
          filename: "wizards.mp4",
          size_bytes: 5,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    expect(await screen.findByRole("button", { name: /loading nba feed/i })).toBeInTheDocument();
    await waitFor(() => expect(sessionBody).toMatchObject({ file_url: "http://127.0.0.1:8000/live/uploads/abc" }));
    resolveSession?.(
      new Response(
        JSON.stringify({
          session_id: "session-1",
          status: "ready",
          source_type: "replay_file",
          team_names: ["WAS", "CHA"],
          event_count: 12,
          warnings: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  });

  it("fails local replay upload without falling back to session start", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    const urls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/live/teams")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/live/uploads")) {
        return new Response(JSON.stringify({ detail: "Replay upload failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <LiveReplay />
      </MemoryRouter>,
    );

    const file = new File(["video"], "wizards.mp4", { type: "video/mp4" });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText(/NBA game id/i), { target: { value: "0022300157" } });
    fireEvent.click(screen.getByRole("button", { name: /start replay/i }));

    expect(await screen.findByText(/Replay upload failed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start replay/i })).toBeEnabled();
    expect(urls.some((url) => url.endsWith("/live/sessions"))).toBe(false);
  });

  it("sends video play and pause state to the backend playback clock", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    const originalConsoleError = console.error;
    vi.spyOn(console, "error").mockImplementation((...args) => {
      if (String(args[0]).includes("not wrapped in act")) return;
      originalConsoleError(...args);
    });
    class FakeEventSource {
      onerror: (() => void) | null = null;
      addEventListener = vi.fn();
      close = vi.fn();
    }
    global.EventSource = FakeEventSource as unknown as typeof EventSource;

    const playbackBodies: unknown[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/live/teams")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/live/sessions")) {
        return new Response(
          JSON.stringify({
            session_id: "session-1",
            status: "ready",
            team_names: ["WAS", "CHA"],
            event_count: 12,
            warnings: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/live/sessions/session-1/playback")) {
        playbackBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <LiveReplay />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /paste url/i }));
    fireEvent.change(screen.getByLabelText(/Replay video URL/i), { target: { value: "https://example.test/replay.mp4" } });
    fireEvent.change(screen.getByLabelText(/NBA game id/i), { target: { value: "0022300157" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start replay/i }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "play", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    video.currentTime = 14;
    video.playbackRate = 1.5;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /play/i }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      fireEvent.pause(video);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(playbackBodies).toEqual(
        expect.arrayContaining([
          { state: "playing", replay_time_sec: 14, playback_rate: 1.5 },
          { state: "paused", replay_time_sec: 14, playback_rate: 1.5 },
        ]),
      );
    });
  });

  it("stops a running session from the stop button", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    class FakeEventSource {
      onerror: (() => void) | null = null;
      addEventListener = vi.fn();
      close = vi.fn();
    }
    global.EventSource = FakeEventSource as unknown as typeof EventSource;

    const stopCalls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/live/teams")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/live/sessions")) {
        return new Response(
          JSON.stringify({
            session_id: "session-running",
            status: "running",
            source_type: "youtube_embed",
            team_names: ["WAS", "CHA"],
            event_count: 0,
            warnings: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/live/sessions/session-running/stop")) {
        stopCalls.push(String(init?.method));
        return new Response(JSON.stringify({ status: "stopping" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <LiveReplay />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /youtube/i }));
    fireEvent.change(screen.getByLabelText(/YouTube broadcast URL/i), {
      target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    });
    fireEvent.change(screen.getByLabelText(/NBA game id/i), { target: { value: "0022300157" } });
    fireEvent.click(screen.getByRole("button", { name: /start live feed/i }));
    const stopButton = await screen.findByRole("button", { name: /stop/i });

    fireEvent.click(stopButton);

    await waitFor(() => expect(stopCalls).toEqual(["POST"]));
    await waitFor(() => expect(screen.getAllByText(/STOPPING/i).length).toBeGreaterThan(0));
  });

  it("reset stops a ready backend session before clearing the broadcast", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    class FakeEventSource {
      onerror: (() => void) | null = null;
      addEventListener = vi.fn();
      close = vi.fn();
    }
    global.EventSource = FakeEventSource as unknown as typeof EventSource;

    const stopCalls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/live/teams")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/live/sessions")) {
        return new Response(
          JSON.stringify({
            session_id: "session-ready",
            status: "ready",
            source_type: "replay_file",
            team_names: ["WAS", "CHA"],
            event_count: 12,
            warnings: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/live/sessions/session-ready/stop")) {
        stopCalls.push(String(init?.method));
        return new Response(JSON.stringify({ status: "stopping" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <LiveReplay />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /paste url/i }));
    fireEvent.change(screen.getByLabelText(/Replay video URL/i), { target: { value: "https://example.test/replay.mp4" } });
    fireEvent.change(screen.getByLabelText(/NBA game id/i), { target: { value: "0022300157" } });
    fireEvent.click(screen.getByRole("button", { name: /start replay/i }));
    const resetButton = await screen.findByRole("button", { name: /reset/i });

    fireEvent.click(resetButton);

    await waitFor(() => expect(stopCalls).toEqual(["POST"]));
    expect(await screen.findByRole("button", { name: /start replay/i })).toBeInTheDocument();
  });

  it("starts a YouTube feed-live session and renders the embedded player", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    class FakeEventSource {
      onerror: (() => void) | null = null;
      addEventListener = vi.fn();
      close = vi.fn();
    }
    global.EventSource = FakeEventSource as unknown as typeof EventSource;

    let sessionBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/live/teams")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/live/sessions")) {
        sessionBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            session_id: "session-yt",
            status: "running",
            source_type: "youtube_embed",
            team_names: ["WAS", "CHA"],
            event_count: 0,
            warnings: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <LiveReplay />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /youtube/i }));
    fireEvent.change(screen.getByLabelText(/YouTube broadcast URL/i), {
      target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    });
    fireEvent.click(screen.getByLabelText(/demo feed events/i));
    fireEvent.change(screen.getByLabelText(/NBA game id/i), { target: { value: "0022300157" } });
    fireEvent.click(screen.getByRole("button", { name: /start live feed/i }));

    await waitFor(() =>
      expect(sessionBody).toMatchObject({
        source_type: "youtube_embed",
        youtube_video_id: "dQw4w9WgXcQ",
        clock_mode: "feed_live",
        nba_game_id: "0022300157",
        demo_feed_events: true,
        include_knowledge: false,
      }),
    );
    expect(sessionBody).not.toHaveProperty("file_url");
    const iframe = await screen.findByTitle("YouTube broadcast");
    expect(iframe).toHaveAttribute("src", expect.stringContaining("/embed/dQw4w9WgXcQ"));
  });

  it("shows a feed-only fallback when YouTube blocks embedding", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    window.YT = {
      Player: class {
        constructor(_elementId: string, options: { events?: { onError?: (event: { data?: number }) => void } }) {
          setTimeout(() => options.events?.onError?.({ data: 150 }), 0);
        }
        destroy = vi.fn();
      },
    };
    class FakeEventSource {
      onerror: (() => void) | null = null;
      addEventListener = vi.fn();
      close = vi.fn();
    }
    global.EventSource = FakeEventSource as unknown as typeof EventSource;

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/live/teams")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/live/sessions")) {
        return new Response(
          JSON.stringify({
            session_id: "session-yt",
            status: "running",
            source_type: "youtube_embed",
            team_names: ["WAS", "CHA"],
            event_count: 0,
            warnings: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <LiveReplay />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /youtube/i }));
    fireEvent.change(screen.getByLabelText(/YouTube broadcast URL/i), {
      target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    });
    fireEvent.change(screen.getByLabelText(/NBA game id/i), { target: { value: "0022300157" } });
    fireEvent.click(screen.getByRole("button", { name: /start live feed/i }));

    expect(await screen.findByText(/EMBED BLOCKED/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open in youtube/i })).toHaveAttribute(
      "href",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(screen.getByRole("button", { name: /continue feed only/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /use replay file/i })).toBeInTheDocument();
  });

  it("merges caption_update events into the existing caption", async () => {
    vi.stubEnv("VITE_BACKEND_URL", "http://127.0.0.1:8000");
    const listeners: Record<string, (message: MessageEvent) => void> = {};
    class FakeEventSource {
      onerror: (() => void) | null = null;
      addEventListener = vi.fn((type: string, listener: (message: MessageEvent) => void) => {
        listeners[type] = listener;
      });
      close = vi.fn();
    }
    global.EventSource = FakeEventSource as unknown as typeof EventSource;

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/live/teams")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/live/sessions")) {
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
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <LiveReplay />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /paste url/i }));
    fireEvent.change(screen.getByLabelText(/Replay video URL/i), { target: { value: "https://example.test/replay.mp4" } });
    fireEvent.change(screen.getByLabelText(/NBA game id/i), { target: { value: "0022300157" } });
    fireEvent.click(screen.getByRole("button", { name: /start replay/i }));

    await waitFor(() => expect(listeners.caption_update).toBeTruthy());
    const initial = {
      type: "caption",
      session_id: "session-1",
      event_id: "evt-1",
      period: 1,
      clock: "11:59",
      event_type: "made_shot",
      text: "Initial template caption.",
      source: "feed",
      confidence: 0.86,
      model_name: "template-live",
      replay_time_sec: 0,
      latency_ms: 0,
      caption_stage: "initial",
    };
    await act(async () => {
      listeners.caption(new MessageEvent("caption", { data: JSON.stringify(initial) }));
    });
    expect(await screen.findByText(/Initial template caption/i)).toBeInTheDocument();

    await act(async () => {
      listeners.caption_update(
        new MessageEvent("caption_update", {
          data: JSON.stringify({
            ...initial,
            type: "caption_update",
            text: "Enriched caption with better rhythm.",
            caption_stage: "enriched",
            enriched_from_event_id: "evt-1",
          }),
        }),
      );
    });

    expect(await screen.findByText(/Enriched caption with better rhythm/i)).toBeInTheDocument();
    expect(screen.queryByText(/Initial template caption/i)).not.toBeInTheDocument();
    expect(screen.getByText(/UPDATED/i)).toBeInTheDocument();
  });

  it("hides captions that are ahead of the video clock", () => {
    window.localStorage.setItem("vision2voice.live.sessionId.v1", JSON.stringify("session-1"));
    window.localStorage.setItem("vision2voice.live.status.v1", JSON.stringify("running"));
    window.localStorage.setItem(
      "vision2voice.live.captions.v1",
      JSON.stringify([
        {
          type: "caption",
          session_id: "session-1",
          event_id: "future",
          period: 1,
          clock: "11:40",
          event_type: "made_shot",
          text: "This line is still ahead of the video.",
          source: "feed",
          confidence: 0.9,
          model_name: "test",
          replay_time_sec: 20,
          latency_ms: 0,
        },
        {
          type: "caption",
          session_id: "session-1",
          event_id: "current",
          period: 1,
          clock: "12:00",
          event_type: "start",
          text: "This line is safe to show.",
          source: "feed",
          confidence: 0.9,
          model_name: "test",
          replay_time_sec: 0,
          latency_ms: 0,
        },
      ]),
    );

    render(
      <MemoryRouter>
        <LiveReplay />
      </MemoryRouter>,
    );

    expect(screen.getByText(/This line is safe to show/i)).toBeInTheDocument();
    expect(screen.queryByText(/This line is still ahead/i)).not.toBeInTheDocument();
  });

  it("shows feed captions beside a restored YouTube session without video-clock filtering", () => {
    window.localStorage.setItem("vision2voice.live.sessionId.v1", JSON.stringify("session-yt"));
    window.localStorage.setItem("vision2voice.live.status.v1", JSON.stringify("running"));
    window.localStorage.setItem("vision2voice.live.activeSourceType.v1", JSON.stringify("youtube_embed"));
    window.localStorage.setItem("vision2voice.live.activeYoutubeVideoId.v1", JSON.stringify("dQw4w9WgXcQ"));
    window.localStorage.setItem(
      "vision2voice.live.captions.v1",
      JSON.stringify([
        {
          type: "caption",
          session_id: "session-yt",
          event_id: "feed-1",
          period: 1,
          clock: "11:40",
          event_type: "made_shot",
          text: "A feed-grounded caption appears beside the broadcast.",
          source: "feed",
          confidence: 0.9,
          model_name: "test",
          replay_time_sec: 700,
          latency_ms: 0,
        },
      ]),
    );

    render(
      <MemoryRouter>
        <LiveReplay />
      </MemoryRouter>,
    );

    expect(screen.getByTitle("YouTube broadcast")).toBeInTheDocument();
    expect(screen.getByText(/A feed-grounded caption appears/i)).toBeInTheDocument();
    expect(screen.getAllByText("FEED").length).toBeGreaterThan(0);
  });

  it("shows a feed-live empty state for restored YouTube sessions without new events", () => {
    window.localStorage.setItem("vision2voice.live.sessionId.v1", JSON.stringify("session-yt"));
    window.localStorage.setItem("vision2voice.live.status.v1", JSON.stringify("running"));
    window.localStorage.setItem("vision2voice.live.activeSourceType.v1", JSON.stringify("youtube_embed"));
    window.localStorage.setItem("vision2voice.live.activeYoutubeVideoId.v1", JSON.stringify("dQw4w9WgXcQ"));
    window.localStorage.setItem("vision2voice.live.captions.v1", JSON.stringify([]));

    render(
      <MemoryRouter>
        <LiveReplay />
      </MemoryRouter>,
    );

    expect(screen.getByText(/WAITING FOR NEW LIVE FEED EVENTS/i)).toBeInTheDocument();
    expect(screen.getByText(/COMPLETED GAMES MAY STAY EMPTY/i)).toBeInTheDocument();
  });
});
