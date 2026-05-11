export type ExtensionMode = "recorded" | "live";

export interface ExtensionSettings {
  backendUrl: string;
  mode: ExtensionMode;
  gameId: string;
  team: string;
  opponent: string;
  season: string;
  seasonType: "Regular Season" | "Playoffs";
  includeKnowledge: boolean;
  demoFeedEvents: boolean;
}

export interface LiveGameSearchResult {
  game_id: string;
  game_date: string;
  season: string;
  season_type: string;
  matchup: string;
  team_abbreviation: string;
  opponent_abbreviation: string;
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
  latency_ms?: number;
  caption_stage?: "initial" | "enriched" | string;
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
      source_type?: string;
      [key: string]: unknown;
    };

export interface StartSessionPayload {
  backendUrl: string;
  body: {
    source_type: "youtube_watch";
    youtube_url: string;
    youtube_video_id: string;
    nba_game_id: string;
    start_period?: number;
    start_clock?: string;
    cadence_sec: number;
    window_sec: number;
    clock_mode: "feed_live" | "replay_media";
    include_knowledge: boolean;
    demo_feed_events?: boolean;
  };
}

export interface PlaybackPayload {
  backendUrl: string;
  sessionId: string;
  body: {
    state: "playing" | "paused";
    replay_time_sec: number;
    playback_rate: number;
    duration_sec?: number;
  };
}

export interface ActiveYouTubeTab {
  tabId: number;
  url: string;
  videoId: string;
}

export interface AttachSessionPayload {
  tabId: number;
  backendUrl: string;
  sessionId: string;
  mode: ExtensionMode;
}

export interface ExtensionActiveSession {
  tabId: number;
  videoId: string;
  backendUrl: string;
  sessionId: string;
  mode: ExtensionMode;
  status: string;
  clock?: string;
  teams?: string[];
  captions?: LiveCaptionEvent[];
  error?: string | null;
  eventCount?: number;
  lastEventType?: string;
}

export type BackgroundRequest =
  | { type: "getActiveYouTubeTab" }
  | { type: "getActiveSession" }
  | { type: "searchGames"; backendUrl: string; params: { team: string; opponent: string; season: string; season_type: string; limit?: number } }
  | { type: "startSession"; payload: StartSessionPayload }
  | { type: "stopSession"; backendUrl: string; sessionId: string }
  | { type: "updatePlayback"; payload: PlaybackPayload }
  | { type: "openEventStream"; backendUrl: string; sessionId: string; tabId?: number }
  | { type: "closeEventStream"; sessionId?: string }
  | { type: "attachSession"; payload: AttachSessionPayload }
  | { type: "detachSession"; tabId: number; sessionId?: string };

export type BackgroundPushMessage =
  | { type: "vision2voice:event"; event: LiveStreamEvent }
  | { type: "vision2voice:stream-error"; sessionId: string; message: string }
  | { type: "vision2voice:attach-session"; payload: Omit<AttachSessionPayload, "tabId"> }
  | { type: "vision2voice:detach-session"; sessionId?: string };
