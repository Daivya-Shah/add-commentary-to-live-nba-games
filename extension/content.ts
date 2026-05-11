import type { BackgroundPushMessage, BackgroundRequest, ExtensionMode } from "./types";

declare const chrome: {
  runtime: {
    sendMessage(request: BackgroundRequest): Promise<{ ok: boolean; data?: unknown; error?: string }>;
    onMessage: {
      addListener(listener: (message: BackgroundPushMessage) => void): void;
    };
  };
};

let activeSessionId: string | null = null;
let activeBackendUrl = "";
let activeMode: ExtensionMode = "recorded";
let cleanupPlayback: (() => void) | null = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "vision2voice:attach-session") {
    activeSessionId = message.payload.sessionId;
    activeBackendUrl = message.payload.backendUrl;
    activeMode = message.payload.mode;
    attachPlaybackSync();
    return;
  }
  if (message.type === "vision2voice:detach-session") {
    if (!message.sessionId || message.sessionId === activeSessionId) detachSession();
    return;
  }
  if (message.type === "vision2voice:stream-error") {
    return;
  }
  if (
    message.event.type === "complete" ||
    message.event.type === "stopped" ||
    message.event.type === "error"
  ) {
    detachSession();
  }
});

window.addEventListener("yt-navigate-finish", detachSession);

function attachPlaybackSync(): void {
  cleanupPlayback?.();
  cleanupPlayback = null;
  if (!activeSessionId || activeMode !== "recorded") return;
  const video = getYouTubeVideo();
  if (!video) return;
  const sendCurrentState = () => {
    if (!activeSessionId || !activeBackendUrl) return;
    void sendPlayback(activeSessionId, activeBackendUrl, video);
  };
  const sendClockHold = () => {
    if (!activeSessionId || !activeBackendUrl) return;
    void sendPlayback(activeSessionId, activeBackendUrl, video, "paused");
  };
  let lastSent = 0;
  const throttledTimeUpdate = () => {
    const now = Date.now();
    if (now - lastSent < 900) return;
    lastSent = now;
    sendCurrentState();
  };
  const events: Array<keyof HTMLMediaElementEventMap> = ["play", "playing", "pause", "seeked", "ratechange", "ended"];
  const holdEvents: Array<keyof HTMLMediaElementEventMap> = ["waiting", "stalled", "suspend"];
  for (const event of events) video.addEventListener(event, sendCurrentState);
  for (const event of holdEvents) video.addEventListener(event, sendClockHold);
  video.addEventListener("timeupdate", throttledTimeUpdate);
  sendCurrentState();
  cleanupPlayback = () => {
    for (const event of events) video.removeEventListener(event, sendCurrentState);
    for (const event of holdEvents) video.removeEventListener(event, sendClockHold);
    video.removeEventListener("timeupdate", throttledTimeUpdate);
  };
}

function detachSession(): void {
  cleanupPlayback?.();
  cleanupPlayback = null;
  activeSessionId = null;
}

async function sendPlayback(
  sessionId: string,
  backendUrl: string,
  video: HTMLVideoElement,
  stateOverride?: "playing" | "paused",
): Promise<void> {
  const duration = isFiniteMediaNumber(video.duration) ? video.duration : undefined;
  await chrome.runtime.sendMessage({
    type: "updatePlayback",
    payload: {
      backendUrl,
      sessionId,
      body: {
        state: stateOverride ?? (video.paused || video.ended ? "paused" : "playing"),
        replay_time_sec: Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0,
        playback_rate: Number.isFinite(video.playbackRate) ? Math.max(0.1, video.playbackRate || 1) : 1,
        ...(duration ? { duration_sec: duration } : {}),
      },
    },
  } satisfies BackgroundRequest);
}

function getYouTubeVideo(): HTMLVideoElement | null {
  return document.querySelector("video.html5-main-video") || document.querySelector("video");
}

function isFiniteMediaNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
