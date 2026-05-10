import { getBackendBaseUrl } from "@/lib/analysis";

export interface LiveSessionRequest {
  file_url?: string;
  nba_game_id: string;
  start_period: number;
  start_clock: string;
  cadence_sec?: number;
  window_sec?: number;
  replay_speed?: number;
  clock_mode?: "replay_media" | "feed_live" | string;
  source_type?: "replay_file" | "youtube_embed";
  youtube_url?: string;
  youtube_video_id?: string;
  demo_feed_events?: boolean;
  include_knowledge?: boolean;
}

export interface LiveSessionResponse {
  session_id: string;
  status: string;
  source_type?: "replay_file" | "youtube_embed" | string;
  team_names: string[];
  event_count: number;
  warnings: string[];
}

export interface LiveUploadResponse {
  upload_id: string;
  file_url: string;
  filename: string;
  size_bytes: number;
}

export interface LiveTeamOption {
  team_id: string;
  name: string;
  abbreviation?: string | null;
  city?: string | null;
}

export interface LiveGameSearchResult {
  game_id: string;
  game_date: string;
  season: string;
  season_type: string;
  matchup: string;
  team_abbreviation: string;
  opponent_abbreviation: string;
  home_team?: string | null;
  away_team?: string | null;
  team_score?: number | null;
  opponent_score?: number | null;
  score?: string | null;
  result?: string | null;
}

export interface LiveCaptionEvent {
  type: "caption" | "caption_update";
  session_id: string;
  event_id: string;
  period: number;
  clock: string;
  event_type: string;
  player_name?: string | null;
  team_name?: string | null;
  score?: string | null;
  text: string;
  source: string;
  confidence: number;
  model_name: string;
  replay_time_sec: number;
  feed_description?: string | null;
  visual_summary?: string | null;
  feed_context?: {
    period?: number;
    clock?: string;
    teams?: string[];
    last_score?: string | null;
    nearest_prior_event?: {
      event_id?: string;
      clock?: string;
      description?: string;
      team_name?: string | null;
    } | null;
  } | null;
  latency_ms: number;
  caption_stage?: "initial" | "enriched" | string;
  generated_at?: string;
  enriched_from_event_id?: string | null;
}

export interface LiveTickEvent {
  type: "tick";
  session_id: string;
  source_type?: string;
  replay_time_sec: number;
  duration_sec: number;
  period: number;
  clock: string;
  score?: string | null;
  event_count?: number;
  playback_rate?: number;
  clock_mode?: string;
}

export interface LivePlaybackControlRequest {
  state: "playing" | "paused";
  replay_time_sec: number;
  playback_rate: number;
}

export type LiveStreamEvent =
  | LiveCaptionEvent
  | LiveTickEvent
  | {
      type:
        | "connected"
        | "session_ready"
        | "status"
        | "complete"
        | "stopped"
        | "error"
        | "ping";
      session_id?: string;
      status?: string;
      error?: string;
      team_names?: string[];
      warnings?: string[];
      replay_time_sec?: number;
      duration_sec?: number | null;
      playback_rate?: number;
      clock_mode?: string;
      [key: string]: unknown;
    };

export function requireBackendBaseUrl(): string {
  const base = getBackendBaseUrl();
  if (!base) {
    throw new Error("Set VITE_BACKEND_URL and run npm run dev:full to use Live Replay.");
  }
  return base;
}

export async function startLiveSession(body: LiveSessionRequest, timeoutMs = 20000): Promise<LiveSessionResponse> {
  const base = requireBackendBaseUrl();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/live/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = data && typeof data.detail === "string" ? data.detail : `Live session failed (${res.status})`;
      throw new Error(detail);
    }
    return data as LiveSessionResponse;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("NBA play-by-play loading timed out. Confirm the game ID and try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function fetchLiveTeams(timeoutMs = 8000): Promise<LiveTeamOption[]> {
  const base = requireBackendBaseUrl();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/live/teams`, { signal: controller.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = data && typeof data.detail === "string" ? data.detail : `Team lookup failed (${res.status})`;
      throw new Error(detail);
    }
    return data as LiveTeamOption[];
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Team lookup timed out. Confirm the backend is reachable.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function uploadLiveReplayFile(file: File, timeoutMs = 90000): Promise<LiveUploadResponse> {
  const base = requireBackendBaseUrl();
  const qs = new URLSearchParams({ filename: file.name || "replay.mp4" });
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/live/uploads?${qs.toString()}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = data && typeof data.detail === "string" ? data.detail : `Replay upload failed (${res.status})`;
      throw new Error(detail);
    }
    return data as LiveUploadResponse;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Replay upload timed out. Try a smaller clip or use URL mode.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function searchLiveGames(params: {
  team: string;
  opponent: string;
  season: string;
  season_type: string;
  limit?: number;
  timeoutMs?: number;
}): Promise<LiveGameSearchResult[]> {
  const base = requireBackendBaseUrl();
  const qs = new URLSearchParams({
    team: params.team,
    opponent: params.opponent,
    season: params.season,
    season_type: params.season_type,
    limit: String(params.limit ?? 20),
  });
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), params.timeoutMs ?? 9000);
  try {
    const res = await fetch(`${base}/live/games/search?${qs.toString()}`, { signal: controller.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = data && typeof data.detail === "string" ? data.detail : `Game search failed (${res.status})`;
      throw new Error(detail);
    }
    return data as LiveGameSearchResult[];
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("NBA game search timed out. Enter the game ID manually or try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function stopLiveSession(sessionId: string): Promise<void> {
  const base = requireBackendBaseUrl();
  const res = await fetch(`${base}/live/sessions/${sessionId}/stop`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const detail = data && typeof data.detail === "string" ? data.detail : `Stop session failed (${res.status})`;
    throw new Error(detail);
  }
}

export async function updateLivePlayback(
  sessionId: string,
  body: LivePlaybackControlRequest,
): Promise<void> {
  const base = requireBackendBaseUrl();
  const res = await fetch(`${base}/live/sessions/${sessionId}/playback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const detail = data && typeof data.detail === "string" ? data.detail : `Playback control failed (${res.status})`;
    throw new Error(detail);
  }
}

export function openLiveEventSource(
  sessionId: string,
  onEvent: (event: LiveStreamEvent) => void,
  onError: (message: string) => void,
): EventSource {
  const base = requireBackendBaseUrl();
  if (typeof EventSource === "undefined") {
    onError("Live event streaming is unavailable in this browser.");
    return { close: () => undefined } as EventSource;
  }
  const source = new EventSource(`${base}/live/sessions/${sessionId}/events`);
  const eventTypes = ["connected", "session_ready", "status", "caption", "caption_update", "tick", "complete", "stopped", "error", "ping"];
  for (const type of eventTypes) {
    source.addEventListener(type, (message) => {
      try {
        onEvent(JSON.parse((message as MessageEvent).data) as LiveStreamEvent);
      } catch {
        onError("Received an unreadable live event.");
      }
    });
  }
  source.onerror = () => {
    onError("Live event stream disconnected.");
  };
  return source;
}

export function normalizeYouTubeVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      const fromQuery = url.searchParams.get("v");
      if (fromQuery && /^[a-zA-Z0-9_-]{11}$/.test(fromQuery)) return fromQuery;
      const parts = url.pathname.split("/").filter(Boolean);
      const markerIndex = parts.findIndex((part) => ["embed", "live", "shorts"].includes(part));
      const id = markerIndex >= 0 ? parts[markerIndex + 1] : null;
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function formatLatency(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatReplayTime(seconds?: number): string {
  const total = Math.max(0, Math.floor(seconds || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}
