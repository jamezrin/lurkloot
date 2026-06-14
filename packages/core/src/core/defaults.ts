import type { Platform, SchedulerState } from "@stream-autopilot/shared/models";

// Pure default scheduler state, shared by the extension's browser.storage layer
// and any other runtime (e.g. the CLI's file-backed storage). Kept browser-free
// here so both can seed/merge state without pulling in extension APIs.
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
