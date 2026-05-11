/* eslint-disable react-refresh/only-export-components */
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { clearActiveSession, DEFAULT_SETTINGS, loadActiveSession, loadSettings, saveActiveSession, saveSettings } from "./storage";
import { extensionStyles } from "./styles";
import type {
  ActiveYouTubeTab,
  BackgroundRequest,
  ExtensionActiveSession,
  ExtensionSettings,
  LiveCaptionEvent,
  LiveGameSearchResult,
} from "./types";
import { currentWatchUrl } from "./youtube";

declare const chrome: {
  runtime: {
    sendMessage(request: BackgroundRequest): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  };
};

function Popup() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveYouTubeTab | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [teams, setTeams] = useState<string[]>([]);
  const [clock, setClock] = useState("Q- --:--");
  const [captions, setCaptions] = useState<LiveCaptionEvent[]>([]);
  const [eventCount, setEventCount] = useState(0);
  const [lastEventType, setLastEventType] = useState("-");
  const [results, setResults] = useState<LiveGameSearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyActiveSession = (active: ExtensionActiveSession) => {
    setSessionId(active.sessionId);
    setStatus(active.status || "ready");
    setTeams(active.teams || []);
    setClock(active.clock || "Q- --:--");
    setCaptions(active.captions || []);
    setError(active.error || null);
    setEventCount(active.eventCount || 0);
    setLastEventType(active.lastEventType || "-");
  };

  useEffect(() => {
    void loadSettings().then((stored) => {
      setSettings(stored);
      setLoaded(true);
    });
    void request<ActiveYouTubeTab>({ type: "getActiveYouTubeTab" })
      .then(async (tab) => {
        setActiveTab(tab);
        const active = await loadActiveSession();
        if (active && active.tabId === tab.tabId && active.videoId === tab.videoId) {
          applyActiveSession(active);
          await request({ type: "openEventStream", backendUrl: active.backendUrl, sessionId: active.sessionId, tabId: active.tabId });
          await request({
            type: "attachSession",
            payload: {
              tabId: active.tabId,
              backendUrl: active.backendUrl,
              sessionId: active.sessionId,
              mode: active.mode,
            },
          });
        }
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadActiveSession().then((active) => {
        if (!activeTab || !active || active.tabId !== activeTab.tabId || active.videoId !== activeTab.videoId) return;
        applyActiveSession(active);
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeTab]);

  useEffect(() => {
    if (loaded) void saveSettings(settings);
  }, [loaded, settings]);

  const canStart = useMemo(
    () => Boolean(activeTab?.videoId && settings.backendUrl.trim() && settings.gameId.trim() && !sessionId),
    [activeTab?.videoId, sessionId, settings.backendUrl, settings.gameId],
  );

  const updateSetting = <K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const searchGames = async () => {
    if (!settings.team.trim() || !settings.opponent.trim()) {
      setError("Enter two NBA teams before searching.");
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const data = await request<LiveGameSearchResult[]>({
        type: "searchGames",
        backendUrl: settings.backendUrl,
        params: {
          team: settings.team.trim(),
          opponent: settings.opponent.trim(),
          season: settings.season.trim(),
          season_type: settings.seasonType,
          limit: 8,
        },
      });
      setResults(data);
      if (!data.length) setError("No matching games found.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  const start = async () => {
    if (!activeTab || !canStart) return;
    setBusy(true);
    setError(null);
    setStatus("starting");
    try {
      const session = await request<{ session_id: string; status: string; team_names?: string[] }>({
        type: "startSession",
        payload: {
          backendUrl: settings.backendUrl,
          body: {
            source_type: "youtube_watch",
            youtube_url: currentWatchUrl(activeTab.videoId),
            youtube_video_id: activeTab.videoId,
            nba_game_id: settings.gameId.trim(),
            cadence_sec: 1,
            window_sec: 2,
            clock_mode: settings.mode === "live" ? "feed_live" : "replay_media",
            include_knowledge: settings.includeKnowledge,
            demo_feed_events: settings.mode === "live" && settings.demoFeedEvents,
          },
        },
      });
      setSessionId(session.session_id);
      setStatus(session.status || "ready");
      setTeams(session.team_names || []);
      setCaptions([]);
      setClock("Q- --:--");
      const activeSession: ExtensionActiveSession = {
        tabId: activeTab.tabId,
        videoId: activeTab.videoId,
        backendUrl: settings.backendUrl,
        sessionId: session.session_id,
        mode: settings.mode,
        status: session.status || "ready",
        teams: session.team_names || [],
        captions: [],
        clock: "Q- --:--",
        error: null,
        eventCount: 0,
        lastEventType: "session_created",
      };
      await saveActiveSession(activeSession);
      await request({ type: "openEventStream", backendUrl: settings.backendUrl, sessionId: session.session_id, tabId: activeTab.tabId });
      await request({
        type: "attachSession",
        payload: {
          tabId: activeTab.tabId,
          backendUrl: settings.backendUrl,
          sessionId: session.session_id,
          mode: settings.mode,
        },
      });
    } catch (err) {
      setStatus("error");
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!sessionId || !activeTab) return;
    setBusy(true);
    setError(null);
    try {
      await request({ type: "detachSession", tabId: activeTab.tabId, sessionId });
      await request({ type: "closeEventStream", sessionId });
      await request({ type: "stopSession", backendUrl: settings.backendUrl, sessionId });
      await clearActiveSession();
      setStatus("stopping");
      setSessionId(null);
      setCaptions([]);
      setClock("Q- --:--");
      setEventCount(0);
      setLastEventType("-");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="v2v-popup">
      <div className="v2v-head">
        <div>
          <div className="v2v-kicker">EXTENSION POPUP</div>
          <div className="v2v-title">LIVE CALL</div>
        </div>
        <span className={`v2v-dot ${sessionId ? "live" : ""}`} />
      </div>
      <div className="v2v-body">
        <div className="v2v-row">
          <label className="v2v-label" htmlFor="v2v-backend">Backend</label>
          <input id="v2v-backend" className="v2v-input" value={settings.backendUrl} onChange={(event) => updateSetting("backendUrl", event.target.value)} />
        </div>
        <div className="v2v-segment" aria-label="YouTube caption mode">
          <button type="button" className={settings.mode === "recorded" ? "active" : ""} onClick={() => updateSetting("mode", "recorded")}>Recorded</button>
          <button type="button" className={settings.mode === "live" ? "active" : ""} onClick={() => updateSetting("mode", "live")}>Live Feed</button>
        </div>
        <div className="v2v-grid two">
          <div className="v2v-row">
            <label className="v2v-label" htmlFor="v2v-team">Team</label>
            <input id="v2v-team" className="v2v-input" value={settings.team} onChange={(event) => updateSetting("team", event.target.value)} placeholder="WAS" />
          </div>
          <div className="v2v-row">
            <label className="v2v-label" htmlFor="v2v-opp">Opponent</label>
            <input id="v2v-opp" className="v2v-input" value={settings.opponent} onChange={(event) => updateSetting("opponent", event.target.value)} placeholder="CHA" />
          </div>
        </div>
        <div className="v2v-grid two">
          <div className="v2v-row">
            <label className="v2v-label" htmlFor="v2v-season">Season</label>
            <input id="v2v-season" className="v2v-input" value={settings.season} onChange={(event) => updateSetting("season", event.target.value)} />
          </div>
          <div className="v2v-row">
            <label className="v2v-label" htmlFor="v2v-season-type">Type</label>
            <select id="v2v-season-type" className="v2v-select" value={settings.seasonType} onChange={(event) => updateSetting("seasonType", event.target.value as ExtensionSettings["seasonType"])}>
              <option>Regular Season</option>
              <option>Playoffs</option>
            </select>
          </div>
        </div>
        <button className="v2v-button secondary" type="button" onClick={searchGames} disabled={searching || busy}>
          {searching ? "Searching..." : "Search Matchup"}
        </button>
        {results.length > 0 && (
          <div className="v2v-results">
            {results.map((result) => (
              <button
                className="v2v-result"
                key={result.game_id}
                type="button"
                onClick={() => {
                  updateSetting("gameId", result.game_id);
                  setResults([]);
                }}
              >
                {result.matchup} · {result.game_date} · {result.game_id}
              </button>
            ))}
          </div>
        )}
        <div className="v2v-row">
          <label className="v2v-label" htmlFor="v2v-game">NBA Game ID</label>
          <input id="v2v-game" className="v2v-input" value={settings.gameId} onChange={(event) => updateSetting("gameId", event.target.value)} placeholder="0022300157" />
        </div>
        <label className="v2v-label">
          <input type="checkbox" checked={settings.includeKnowledge} onChange={(event) => updateSetting("includeKnowledge", event.target.checked)} /> Include knowledge enrichment
        </label>
        {settings.mode === "live" && (
          <label className="v2v-label">
            <input type="checkbox" checked={settings.demoFeedEvents} onChange={(event) => updateSetting("demoFeedEvents", event.target.checked)} /> Demo feed event
          </label>
        )}
        <div className="v2v-actions">
          <button className="v2v-button" type="button" onClick={start} disabled={!canStart || busy}>
            {busy && !sessionId ? "Starting..." : "Start"}
          </button>
          <button className="v2v-button secondary" type="button" onClick={stop} disabled={!sessionId || busy}>
            Stop
          </button>
        </div>
        <div className="v2v-status">
          <span>{status.toUpperCase()}</span>
          <span>{clock}</span>
        </div>
        <div className="v2v-status compact">
          <span>EVENTS {eventCount}</span>
          <span>{lastEventType.toUpperCase()}</span>
        </div>
        {teams.length > 0 && <div className="v2v-label">{teams.join(" · ")}</div>}
        {error && <div className="v2v-error">{error}</div>}
        <section className="v2v-history" aria-label="Generated captions">
          {captions.length === 0 ? (
            <div className="v2v-empty">
              No captions yet. Recorded mode needs the YouTube video playing and aligned to a game clock that crosses play-by-play events. Live Feed mode only emits new plays; for local testing, enable Demo feed event and set backend LIVE_FEED_DEMO_ENABLED=1.
            </div>
          ) : (
            captions.slice(0, 8).map((caption) => (
              <article className="v2v-caption-row" key={`${caption.event_id}-${caption.caption_stage || "initial"}`}>
                <div className="v2v-caption-meta">
                  Q{caption.period} {caption.clock} · {caption.source}
                </div>
                <div className="v2v-caption-text">{caption.text}</div>
              </article>
            ))
          )}
        </section>
      </div>
    </main>
  );
}

async function request<T = unknown>(request: BackgroundRequest): Promise<T> {
  const response = await chrome.runtime.sendMessage(request);
  if (!response?.ok) throw new Error(response?.error || "Vision2Voice extension request failed.");
  return response.data as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

const style = document.createElement("style");
style.textContent = extensionStyles;
document.head.appendChild(style);
createRoot(document.getElementById("root")!).render(<Popup />);
