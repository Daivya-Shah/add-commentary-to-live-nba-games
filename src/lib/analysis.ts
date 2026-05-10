import { supabase } from "@/integrations/supabase/client";

/** Normalized 0–1 time range; UI maps to video currentTime / duration. */
export interface PossessionSegment {
  t0: number;
  t1: number;
  event_type: string;
  player_name: string;
  team_name: string;
  jersey_number_primary?: string | null;
}

/** Stats for one player who appeared in the clip. */
export interface PlayerContext {
  player_name: string;
  team_name: string;
  jersey_number?: string | null;
  player_stats?: Record<string, unknown>;
  team_stats?: Record<string, unknown>;
}

export interface ScoreboardInfo {
  home_team?: string | null;
  home_score?: number | null;
  away_team?: string | null;
  away_score?: number | null;
  quarter?: string | number | null;
  game_clock?: string | null;
  shot_clock?: number | null;
}

export interface OnScreenText {
  game_title?: string | null;
  broadcaster?: string | null;
  player_stat_overlay?: string | null;
  other?: string[] | null;
}

export interface AnalysisResult {
  event_type: string;
  player_name: string;
  team_name: string;
  confidence: number;
  visual_summary: string;
  retrieved_context?: {
    player_stats?: Record<string, unknown>;
    team_stats?: Record<string, unknown>;
  };
  commentary_text: string;
  model_name?: string;
  possession_timeline?: PossessionSegment[];
  segment_commentary_lines?: string[];
  players_stats?: PlayerContext[];
  scoreboard?: ScoreboardInfo | null;
  on_screen_text?: OnScreenText | null;
  duration?: number;
  chunks_processed?: number;
}

// ── Real-time frame analysis ─────────────────────────────────────────────────

export interface FrameRequest {
  frame_data: string;        // base64 JPEG captured from the video element
  timestamp?: number;        // current video.currentTime
  duration?: number;         // video.duration
  prev_player?: string | null;
  prev_jersey?: string | null;
  prev_team?: string | null;
}

export interface FrameResult {
  player_name: string;
  jersey_number: string | null;
  team_name: string;
  event_type: string;
  confidence: number;
  commentary: string;
  scoreboard?: ScoreboardInfo | null;
  on_screen_text?: OnScreenText | null;
  timestamp: number;
}

export async function analyzeFrame(req: FrameRequest): Promise<FrameResult> {
  const base = import.meta.env.VITE_BACKEND_URL?.replace(/\/$/, "");
  if (!base) throw new Error("VITE_BACKEND_URL not set");
  const res = await fetch(`${base}/analyze-frame`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => `${res.status}`);
    throw new Error(msg);
  }
  return res.json();
}

export async function fetchPlayerStats(
  playerName: string,
  teamName: string,
): Promise<{ player_stats: Record<string, unknown>; team_stats: Record<string, unknown> }> {
  const base = import.meta.env.VITE_BACKEND_URL?.replace(/\/$/, "");
  if (!base) throw new Error("VITE_BACKEND_URL not set");
  const res = await fetch(`${base}/player-stats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player_name: playerName, team_name: teamName }),
  });
  if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`);
  return res.json();
}

// ── Streaming types ──────────────────────────────────────────────────────────

export type StreamEvent =
  | { type: "status"; step: string; message: string; chunk_index?: number; chunk_total?: number; chunk_start?: number; chunk_end?: number }
  | { type: "video_info"; duration: number; total_chunks: number }
  | {
      type: "vision_chunk";
      chunk_index: number;
      chunk_total: number;
      chunk_start: number;
      chunk_end: number;
      event_type: string;
      player_name: string;
      team_name: string;
      confidence: number;
      segments: PossessionSegment[];
      scoreboard?: ScoreboardInfo | null;
      on_screen_text?: OnScreenText | null;
    }
  | { type: "segment"; index: number; line: string; segment: PossessionSegment }
  | {
      type: "complete";
      commentary_text: string;
      segment_commentary_lines: string[];
      visual_summary: string;
      players_stats: PlayerContext[];
      scoreboard?: ScoreboardInfo | null;
      on_screen_text?: OnScreenText | null;
      model_name: string;
      duration?: number;
      chunks_processed?: number;
    }
  | { type: "error"; message: string };

/** Shared SSE reader — parses text/event-stream from a fetch Response. */
async function* _readSSE(res: Response): AsyncGenerator<StreamEvent> {
  if (!res.body) throw new Error("No response body");
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try { yield JSON.parse(line.slice(6)) as StreamEvent; } catch { /* skip */ }
      }
    }
  }
}

/**
 * Send the video FILE directly to the backend (multipart upload).
 * No Supabase storage → no 50 MB size limit. Works for videos of any length.
 */
export async function* uploadAndAnalyzeStream(
  file: File,
  clipId: string = "local",
): AsyncGenerator<StreamEvent> {
  const base = import.meta.env.VITE_BACKEND_URL?.replace(/\/$/, "");
  if (!base) throw new Error("VITE_BACKEND_URL is not set");

  // Send the file as a raw binary body — no FormData, no python-multipart needed.
  // clip_id goes in the query string instead.
  const url = `${base}/upload-analyze-stream?clip_id=${encodeURIComponent(clipId)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,          // Browser streams the file; never fully buffered in JS
      // @ts-ignore — duplex needed for streaming uploads in some environments
      duplex: "half",
    });
  } catch {
    throw new Error(
      "Cannot reach backend. Make sure it is running: npm run dev:full"
    );
  }

  if (!res.ok) {
    const msg = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`Backend error: ${msg}`);
  }
  yield* _readSSE(res);
}

/**
 * Analyze a video already hosted at a URL (legacy / Supabase-stored path).
 */
export async function* analyzeStream(
  clipId: string,
  fileUrl: string,
): AsyncGenerator<StreamEvent> {
  const base = import.meta.env.VITE_BACKEND_URL?.replace(/\/$/, "");
  if (!base) throw new Error("VITE_BACKEND_URL is not set");

  const res = await fetch(`${base}/analyze-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clip_id: clipId, file_url: fileUrl }),
  });

  if (!res.ok) throw new Error(`Backend error ${res.status}`);
  yield* _readSSE(res);
}

// ── Legacy (non-streaming) path ──────────────────────────────────────────────

function parseBackendError(res: Response, body: unknown): Error {
  if (typeof body === "object" && body !== null && "detail" in body) {
    const d = (body as { detail: unknown }).detail;
    if (typeof d === "string") return new Error(d);
    return new Error(JSON.stringify(d));
  }
  if (typeof body === "object" && body !== null && "error" in body) {
    const e = (body as { error: unknown }).error;
    return new Error(typeof e === "string" ? e : JSON.stringify(e));
  }
  return new Error(`Request failed (${res.status})`);
}

async function analyzeDirect(
  clipId: string,
  fileUrl: string,
  action?: "regenerate"
): Promise<AnalysisResult> {
  const base = import.meta.env.VITE_BACKEND_URL?.replace(/\/$/, "");
  if (!base) throw new Error("VITE_BACKEND_URL is not set");

  const path = action === "regenerate" ? "/regenerate" : "/analyze";
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clip_id: clipId, file_url: fileUrl }),
  });

  let data: unknown;
  try { data = await res.json(); } catch {
    throw new Error(`Bad response from backend (${res.status})`);
  }
  if (!res.ok) throw parseBackendError(res, data);

  const payload = data as AnalysisResult & { error?: string };
  if (payload?.error) throw new Error(payload.error);
  return payload as AnalysisResult;
}

async function analyzeEdge(
  clipId: string,
  fileUrl: string,
  action?: "regenerate"
): Promise<AnalysisResult> {
  const { data, error: fnError } = await supabase.functions.invoke("process-video", {
    body: { clip_id: clipId, file_url: fileUrl, ...(action ? { action } : {}) },
  });
  if (fnError) throw new Error(fnError.message);
  const payload = data as AnalysisResult & { error?: string };
  if (payload?.error) throw new Error(payload.error);
  return payload as AnalysisResult;
}

export function useDirectBackend(): boolean {
  return Boolean(import.meta.env.VITE_BACKEND_URL?.trim());
}

export async function runAnalysisPipeline(
  clipId: string,
  fileUrl: string,
  action?: "regenerate"
): Promise<AnalysisResult> {
  if (useDirectBackend()) return analyzeDirect(clipId, fileUrl, action);
  return analyzeEdge(clipId, fileUrl, action);
}

export function getBackendBaseUrl(): string | undefined {
  const b = import.meta.env.VITE_BACKEND_URL?.trim().replace(/\/$/, "");
  return b || undefined;
}

export async function exportCommentaryVideo(
  fileUrl: string,
  commentaryText: string,
  opts?: {
    possession_timeline?: PossessionSegment[];
    segment_commentary_lines?: string[];
  }
): Promise<Blob> {
  const base = getBackendBaseUrl();
  if (!base) throw new Error("Set VITE_BACKEND_URL in .env to use voiceover export.");

  const tl = opts?.possession_timeline;
  const sl = opts?.segment_commentary_lines;
  const useTimeline = Array.isArray(tl) && Array.isArray(sl) && tl.length > 0 && tl.length === sl.length;

  const res = await fetch(`${base}/export-commentary-video`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      file_url: fileUrl,
      commentary_text: commentaryText,
      ...(useTimeline ? { possession_timeline: tl, segment_commentary_lines: sl } : {}),
    }),
  });

  if (!res.ok) {
    let msg = await res.text();
    try {
      const j = JSON.parse(msg) as { detail?: unknown };
      if (typeof j.detail === "string") msg = j.detail;
      else if (j.detail != null) msg = JSON.stringify(j.detail);
    } catch { /* raw text */ }
    throw new Error(msg || `Voiceover export failed (${res.status})`);
  }
  return res.blob();
}
