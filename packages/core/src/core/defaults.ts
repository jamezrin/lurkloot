import type { Platform, SchedulerState } from "@lurkloot/shared/models";

// Pure default scheduler state, shared by the extension's browser.storage layer
// and any other runtime (e.g. a headless CLI's file-backed storage). Kept
// browser-free here so both can seed/merge state without pulling in extension
// APIs.
const emptySession = (platform: Platform) => ({
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
  managedPageContextTabs: {},
  campaigns: {
    twitch: [],
    kick: [],
  },
  events: [],
};

// Merges a persisted (possibly partial/older) state over DEFAULT_STATE, ensuring
// every per-platform slice is present. Shared by the extension's browser.storage
// layer and any file-backed storage so a new top-level slice only has to be
// added in one place.
export function mergeSchedulerState(stored: Partial<SchedulerState> | undefined): SchedulerState {
  return {
    ...DEFAULT_STATE,
    ...stored,
    sessions: { ...DEFAULT_STATE.sessions, ...stored?.sessions },
    managedWatchTabs: { ...DEFAULT_STATE.managedWatchTabs, ...stored?.managedWatchTabs },
    managedPageContextTabs: { ...DEFAULT_STATE.managedPageContextTabs, ...stored?.managedPageContextTabs },
    manualWatch: { ...stored?.manualWatch },
    campaigns: { ...DEFAULT_STATE.campaigns, ...stored?.campaigns },
  };
}
