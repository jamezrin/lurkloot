import { browser } from "wxt/browser";
import type { EventLogEntry, ExtensionSettings, SchedulerState } from "./models";
import { DEFAULT_SETTINGS, mergeSettings } from "./settings";

const SETTINGS_KEY = "settings";
const STATE_KEY = "schedulerState";

const emptySession = (platform: "twitch" | "kick") => ({
  platform,
  offlineChecks: 0,
  status: "idle" as const,
});

export const DEFAULT_STATE: SchedulerState = {
  sessions: {
    twitch: emptySession("twitch"),
    kick: emptySession("kick"),
  },
  managedWatchTabs: {},
  campaigns: {
    twitch: [],
    kick: [],
  },
  diagnostics: undefined,
  events: [],
};

export async function loadSettings(): Promise<ExtensionSettings> {
  const data = await browser.storage.local.get(SETTINGS_KEY);
  return mergeSettings(data[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined);
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function loadState(): Promise<SchedulerState> {
  const data = await browser.storage.local.get(STATE_KEY);
  return {
    ...DEFAULT_STATE,
    ...(data[STATE_KEY] as Partial<SchedulerState> | undefined),
    sessions: {
      ...DEFAULT_STATE.sessions,
      ...(data[STATE_KEY] as Partial<SchedulerState> | undefined)?.sessions,
    },
    managedWatchTabs: {
      ...DEFAULT_STATE.managedWatchTabs,
      ...(data[STATE_KEY] as Partial<SchedulerState> | undefined)?.managedWatchTabs,
    },
    campaigns: {
      ...DEFAULT_STATE.campaigns,
      ...(data[STATE_KEY] as Partial<SchedulerState> | undefined)?.campaigns,
    },
    diagnostics: (data[STATE_KEY] as Partial<SchedulerState> | undefined)?.diagnostics,
  };
}

export async function saveState(state: SchedulerState): Promise<void> {
  await browser.storage.local.set({ [STATE_KEY]: state });
}

export function appendEvent(
  state: SchedulerState,
  entry: Omit<EventLogEntry, "id" | "at">,
): SchedulerState {
  const fullEntry: EventLogEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
  };
  return {
    ...state,
    events: [fullEntry, ...state.events].slice(0, 100),
  };
}

export async function resetStorage(): Promise<void> {
  await browser.storage.local.set({
    [SETTINGS_KEY]: DEFAULT_SETTINGS,
    [STATE_KEY]: DEFAULT_STATE,
  });
}
