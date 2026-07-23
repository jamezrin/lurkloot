import type {
  CategorySelection,
  ChannelCandidate,
  ChannelCheck,
  DropCampaign,
  DropReward,
  ManagedWatchTab,
  Platform,
  PlatformAuthHealth,
  WatchSession,
} from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { ResolvedCompatibility } from "../compatibility/types";
import type { LogLevel } from "@lurkloot/shared/logging";
import type { TablessWatchController } from "../core/tablessWatch";

export const ignoreEvent: EventEmitter = () => {};

export function diagnostic(emit: EventEmitter, level: LogLevel, message: string, platform: Platform): void {
  emit({ category: "diagnostic", level, message, platform });
}

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

// A gamification challenge that was just claimed. Account-level, so unlike
// channel points it is not tied to a channel or a watch session.
export interface ClaimedChallenge {
  id: string;
  rarity: string;
  recurrence: string;
}

export interface PlatformAdapter {
  platform: Platform;
  readonly compatibility?: ResolvedCompatibility[Platform];
  checkAuthHealth(): Promise<PlatformAuthHealth>;
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
  // Claims any completed, unclaimed gamification challenges for the logged-in
  // account and reports what was won. Account-level, so it takes no channel and
  // runs regardless of whether a watch session is active.
  claimChallenges?(): Promise<ClaimedChallenge[]>;
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
  // Whether a bounded post-claim refresh is worthwhile on this platform. Twitch
  // only reveals the next reward in a campaign chain on a subsequent inventory
  // read, so re-polling recovers watch time the fixed alarm would otherwise
  // waste. Kick's tabless watcher holds a persistent viewer socket and paces
  // its own sends, so it has no equivalent dead minute to recover.
  supportsPostClaimHandoff?: boolean;
}

export interface PageFetcher {
  fetchJson<T>(url: string, init?: RequestInit, emit?: EventEmitter): Promise<T>;
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
