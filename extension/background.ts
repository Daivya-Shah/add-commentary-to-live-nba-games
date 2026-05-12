import { normalizeYouTubeVideoId } from "./youtube";
import { loadActiveSession, saveActiveSession } from "./storage";
import type { ActiveYouTubeTab, BackgroundRequest, BackgroundPushMessage, ExtensionActiveSession, LiveCaptionEvent, LiveStreamEvent } from "./types";

declare const chrome: {
  runtime: {
    onMessage: {
      addListener(listener: (request: BackgroundRequest, sender: { tab?: { id?: number } }, sendResponse: (response?: unknown) => void) => boolean | void): void;
    };
  };
  tabs: {
    query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<Array<{ id?: number; url?: string }>>;
    sendMessage(tabId: number, message: BackgroundPushMessage): Promise<void>;
  };
};

const streams = new Map<string, AbortController>();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  void handleMessage(request, sender.tab?.id)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function handleMessage(request: BackgroundRequest, tabId?: number): Promise<unknown> {
  switch (request.type) {
    case "getActiveYouTubeTab":
      return getActiveYouTubeTab();
    case "getActiveSession":
      return loadActiveSession();
    case "searchGames":
      return searchGames(request.backendUrl, request.params);
    case "startSession":
      return postJson(request.payload.backendUrl, "/live/sessions", request.payload.body);
    case "stopSession":
      return postJson(request.backendUrl, `/live/sessions/${request.sessionId}/stop`, undefined);
    case "updatePlayback":
      return postJson(request.payload.backendUrl, `/live/sessions/${request.payload.sessionId}/playback`, request.payload.body);
    case "openEventStream":
      if (typeof request.tabId !== "number" && typeof tabId !== "number") {
        throw new Error("No YouTube tab is available for the live event stream.");
      }
      openEventStream(request.backendUrl, request.sessionId, request.tabId ?? tabId ?? 0);
      return { streaming: true };
    case "closeEventStream":
      closeEventStream(request.sessionId);
      return { streaming: false };
    case "attachSession":
      await sendToTab(request.payload.tabId, {
        type: "vision2voice:attach-session",
        payload: {
          backendUrl: request.payload.backendUrl,
          sessionId: request.payload.sessionId,
          mode: request.payload.mode,
        },
      });
      return { attached: true };
    case "detachSession":
      await sendToTab(request.tabId, { type: "vision2voice:detach-session", sessionId: request.sessionId });
      return { detached: true };
    default:
      throw new Error("Unknown Vision2Voice extension message.");
  }
}

async function getActiveYouTubeTab(): Promise<ActiveYouTubeTab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;
  const url = tab?.url || "";
  const videoId = normalizeYouTubeVideoId(url);
  if (typeof tabId !== "number" || !videoId) {
    throw new Error("Open a YouTube video or live page before using Vision2Voice.");
  }
  return { tabId, url, videoId };
}

async function searchGames(
  backendUrl: string,
  params: { team: string; opponent: string; season: string; season_type: string; limit?: number },
): Promise<unknown> {
  const qs = new URLSearchParams({
    team: params.team,
    opponent: params.opponent,
    season: params.season,
    season_type: params.season_type,
    limit: String(params.limit ?? 10),
  });
  const res = await fetch(`${baseUrl(backendUrl)}/live/games/search?${qs.toString()}`);
  return readJsonResponse(res, "Game search failed");
}

async function postJson(backendUrl: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl(backendUrl)}${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readJsonResponse(res, "Backend request failed");
}

function openEventStream(backendUrl: string, sessionId: string, tabId: number): void {
  closeEventStream(sessionId);
  const controller = new AbortController();
  streams.set(sessionId, controller);
  void pumpEventStream(backendUrl, sessionId, tabId, controller);
}

function closeEventStream(sessionId?: string): void {
  if (sessionId) {
    streams.get(sessionId)?.abort();
    streams.delete(sessionId);
    return;
  }
  for (const controller of streams.values()) controller.abort();
  streams.clear();
}

async function pumpEventStream(
  backendUrl: string,
  sessionId: string,
  tabId: number,
  controller: AbortController,
): Promise<void> {
  try {
    const res = await fetch(`${baseUrl(backendUrl)}/live/sessions/${sessionId}/events`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) {
      throw new Error(`Live event stream failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        await recordStreamEvent(sessionId, event);
        await sendToTab(tabId, { type: "vision2voice:event", event });
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      await recordStreamError(sessionId, error instanceof Error ? error.message : "Live event stream disconnected.");
      await sendToTab(tabId, {
        type: "vision2voice:stream-error",
        sessionId,
        message: error instanceof Error ? error.message : "Live event stream disconnected.",
      });
    }
  } finally {
    if (streams.get(sessionId) === controller) streams.delete(sessionId);
  }
}

async function recordStreamEvent(sessionId: string, event: LiveStreamEvent): Promise<void> {
  const active = await loadActiveSession();
  if (!active || active.sessionId !== sessionId) return;
  const next: ExtensionActiveSession = { ...active, error: null };
  next.lastEventType = event.type;
  if (event.type === "caption" || event.type === "caption_update") {
    next.captions = mergeCaptionEvent(active.captions || [], event);
    next.clock = `Q${event.period} ${event.clock}`;
    next.status = "running";
  } else if (event.type === "tick") {
    next.clock = `Q${event.period} ${event.clock}`;
    if (typeof event.event_count === "number") next.eventCount = event.event_count;
    next.status = event.score ? `running · ${event.score}` : next.status || "running";
  } else if (event.type === "connected" || event.type === "session_ready" || event.type === "status") {
    if (event.status) next.status = String(event.status);
    if (Array.isArray(event.team_names)) next.teams = event.team_names;
  } else if (event.type === "complete" || event.type === "stopped") {
    next.status = event.type;
  } else if (event.type === "error") {
    next.status = "error";
    next.error = String(event.error || "Live session failed.");
  }
  await saveActiveSession(next);
  if (event.type === "complete" || event.type === "stopped") {
    closeEventStream(sessionId);
  }
}

async function recordStreamError(sessionId: string, message: string): Promise<void> {
  const active = await loadActiveSession();
  if (!active || active.sessionId !== sessionId) return;
  await saveActiveSession({ ...active, status: "stream error", error: message });
}

function mergeCaptionEvent(
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

async function sendToTab(tabId: number, message: BackgroundPushMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // The YouTube tab may have navigated away; the stream cleanup path will handle it.
  }
}

async function readJsonResponse(res: Response, fallback: string): Promise<unknown> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data && typeof data.detail === "string" ? data.detail : `${fallback} (${res.status})`;
    throw new Error(detail);
  }
  return data;
}

function baseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/$/, "");
  if (!trimmed) throw new Error("Set a Vision2Voice backend URL first.");
  return trimmed;
}

function parseSseChunk(buffer: string): { events: LiveStreamEvent[]; rest: string } {
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

export {};
