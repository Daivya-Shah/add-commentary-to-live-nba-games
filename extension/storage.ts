import type { ExtensionActiveSession, ExtensionSettings } from "./types";

declare const chrome: {
  storage?: {
    local?: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  backendUrl: "http://127.0.0.1:8000",
  mode: "recorded",
  gameId: "",
  team: "",
  opponent: "",
  season: defaultNbaSeason(),
  seasonType: "Regular Season",
  includeKnowledge: false,
  demoFeedEvents: false,
};

const SETTINGS_KEY = "vision2voice.youtube.settings.v1";
const ACTIVE_SESSION_KEY = "vision2voice.youtube.activeSession.v1";

export async function loadSettings(): Promise<ExtensionSettings> {
  try {
    const data = await chrome.storage?.local?.get([SETTINGS_KEY]);
    return { ...DEFAULT_SETTINGS, ...((data?.[SETTINGS_KEY] as Partial<ExtensionSettings>) || {}) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  try {
    await chrome.storage?.local?.set({ [SETTINGS_KEY]: settings });
  } catch {
    // Storage is best-effort in tests and restricted extension contexts.
  }
}

export async function loadActiveSession(): Promise<ExtensionActiveSession | null> {
  try {
    const data = await chrome.storage?.local?.get([ACTIVE_SESSION_KEY]);
    return (data?.[ACTIVE_SESSION_KEY] as ExtensionActiveSession | undefined) || null;
  } catch {
    return null;
  }
}

export async function saveActiveSession(session: ExtensionActiveSession): Promise<void> {
  try {
    await chrome.storage?.local?.set({ [ACTIVE_SESSION_KEY]: session });
  } catch {
    // Storage is best-effort in restricted extension contexts.
  }
}

export async function clearActiveSession(): Promise<void> {
  try {
    await chrome.storage?.local?.set({ [ACTIVE_SESSION_KEY]: null });
  } catch {
    // Storage is best-effort in restricted extension contexts.
  }
}

function defaultNbaSeason(): string {
  const now = new Date();
  const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}
