import type {
  CategorySelection,
  ChannelCandidate,
  ChannelCheck,
  DropCampaign,
  DropReward,
  ManagedWatchTab,
  Platform,
  WatchSession,
} from "@lurkloot/shared/models";
import type { TablessWatchController } from "../core/tablessWatch";

export interface PreparedWatchTab {
  tabId: number;
  managedByExtension: boolean;
  managedTab?: ManagedWatchTab;
}

export interface WatchTabOptions {
  muted: boolean;
  closeManagedTabs: boolean;
  keepVideosUnmuted: boolean;
  managedTab?: ManagedWatchTab;
}

export interface PlatformAdapter {
  platform: Platform;
  discoverCampaigns(): Promise<DropCampaign[]>;
  readProgress(campaigns: DropCampaign[], session?: WatchSession): Promise<DropCampaign[]>;
  listCandidateChannels(campaign: DropCampaign): Promise<ChannelCandidate[]>;
  checkChannel(channel: ChannelCandidate, campaign?: DropCampaign): Promise<ChannelCheck>;
  claimReward(campaign: DropCampaign, reward: DropReward): Promise<boolean>;
  // Whether a "claimable" reward can actually be claimed right now. Twitch only
  // exposes the real drop-instance id once it releases the claim, so auto-claim
  // must defer until then instead of POSTing a value Twitch will reject.
  isClaimReady?(reward: DropReward): boolean;
  claimChannelPoints?(channel: ChannelCandidate): Promise<boolean>;
  // Live search of the platform's categories/games, powering the "Farm only these
  // categories" picker in Settings. Returns id + name (+ box art) matches.
  searchCategories?(query: string): Promise<CategorySelection[]>;
  prepareWatchTab(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>): Promise<PreparedWatchTab>;
  stopWatchTab?(session: WatchSession, options?: Partial<WatchTabOptions>): Promise<void>;
  // Tabless (low-resource) farming. When supported, the controller drives a
  // TablessWatchController instead of opening a watch tab; the tab path stays as
  // the automatic fallback when heartbeats stop earning.
  supportsTabless?: boolean;
  createTablessWatcher?(): TablessWatchController;
}

export interface PageFetcher {
  fetchJson<T>(url: string, init?: RequestInit): Promise<T>;
}

// Opens/closes the watch tab an adapter drives in tab-based (non-tabless) mode.
// Browser-bound, so it is injected rather than imported: the extension backs it
// with wxt/browser tabs (see the extension's core/tabs wrappers over
// open/stopWatchTabWithBrowser); a headless runtime backs it with a real page or
// leaves it unconfigured when running tabless-only.
export interface WatchTabPort {
  openPinnedMutedTab(channel: ChannelCandidate, session?: WatchSession, options?: Partial<WatchTabOptions>): Promise<PreparedWatchTab>;
  stopWatchTab(session: WatchSession, options?: Partial<WatchTabOptions>): Promise<void>;
}

// Default watch-tab port for runtimes that never open a tab (headless tabless
// mode, unit tests): opening fails loudly, while stopping is a harmless no-op
// (nothing to stop without a tab, but the scheduler still calls it to clean up
// idle/disabled platforms). Runtimes that watch via a tab inject a real port.
export const unavailableWatchTabPort: WatchTabPort = {
  openPinnedMutedTab() {
    throw new Error("No watch-tab port configured; this runtime cannot open a watch tab (enable tabless mode or inject a WatchTabPort)");
  },
  async stopWatchTab() {
    // nothing to stop without a tab
  },
};
