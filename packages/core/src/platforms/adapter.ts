import type { ChatPresenceClient } from "../core/chatPresence";
import type {
  CategorySelection,
  ChannelCandidate,
  ChannelCheck,
  DropCampaign,
  DropReward,
  Platform,
  PlatformAuthHealth,
  WatchSession,
} from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { ResolvedCompatibility } from "../compatibility/types";
import type { LogLevel } from "@lurkloot/shared/logging";
import type { TablessWatchController } from "../core/tablessWatch";
import type { DiscoverySignalController } from "../core/discoverySignals";
import type { TwitchChannelPointsPushController } from "./twitch/channelPointsPush";

export const ignoreEvent: EventEmitter = () => {};

export function diagnostic(emit: EventEmitter, level: LogLevel, message: string, platform: Platform): void {
  emit({ category: "diagnostic", level, message, platform });
}

export interface AdapterOperationOptions {
  signal?: AbortSignal;
  // Snapshot discovery must reject missing evidence instead of publishing a
  // partial inventory. Standalone operations may retain their best-effort path.
  requireComplete?: boolean;
}

export interface ChannelPointsClaimOptions extends AdapterOperationOptions {
  claimId?: string;
  channelId?: string;
}

export interface ChannelCheckRequest {
  channel: ChannelCandidate;
  campaign?: DropCampaign;
}

export interface ChannelCheckBatch {
  // Request order; undefined is allowed only after an earlier successful check
  // for that campaign. Idle requests always require their own observation.
  checks: Array<ChannelCheck | undefined>;
  uniqueChannelChecks: number;
}

export interface CandidateChannelSelection {
  channel?: ChannelCandidate;
  checked: number;
  observations?: ChannelCheck[];
  metrics?: {
    cacheHits: number;
    cacheMisses: number;
    batchRequests: number;
    singleFallbacks: number;
  };
}

export interface KickPageContextCycleObservation {
  backgroundHosts: string[];
  fallbackHosts: string[];
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
  // Call after a logical operation drains. Independent from consume-once
  // page-context recovery observations; does not declare a cycle successful.
  flushRouteDiagnostics?(emit: EventEmitter): void;
  readonly compatibility?: ResolvedCompatibility[Platform];
  checkAuthHealth(signal?: AbortSignal): Promise<PlatformAuthHealth>;
  refreshCampaigns(session?: WatchSession, options?: AdapterOperationOptions): Promise<DropCampaign[]>;
  listCandidateChannels(campaign: DropCampaign, options?: AdapterOperationOptions): Promise<ChannelCandidate[]>;
  selectCandidateChannel?(
    candidates: ChannelCandidate[],
    campaign?: DropCampaign,
    options?: AdapterOperationOptions,
  ): Promise<CandidateChannelSelection>;
  // Logins of live channels the signed-in account follows. Used only to break
  // ties between candidates that are already eligible for the same campaign, so
  // a platform without a follow API (or a signed-out session) can return an
  // empty list and lose nothing but the preference.
  listFollowedChannels?(options?: AdapterOperationOptions): Promise<string[]>;
  checkChannel(channel: ChannelCandidate, options?: AdapterOperationOptions & { campaign?: DropCampaign }): Promise<ChannelCheck>;
  // One revision only: implementations may share equivalent provider evidence,
  // but must preserve campaign-specific decisions and drain all work on failure.
  checkChannels?(requests: ChannelCheckRequest[], options?: AdapterOperationOptions): Promise<ChannelCheckBatch>;
  claimReward(campaign: DropCampaign, reward: DropReward, options?: AdapterOperationOptions): Promise<boolean>;
  // Whether a "claimable" reward can actually be claimed right now. Twitch only
  // exposes the real drop-instance id once it releases the claim, so auto-claim
  // must defer until then instead of POSTing a value Twitch will reject.
  isClaimReady?(reward: DropReward): boolean;
  claimChannelPoints?(channel: ChannelCandidate, options?: ChannelPointsClaimOptions): Promise<boolean>;
  // Claims any completed, unclaimed gamification challenges for the logged-in
  // account and reports what was won. Account-level, so it takes no channel and
  // runs regardless of whether a watch session is active.
  claimChallenges?(options?: AdapterOperationOptions): Promise<ClaimedChallenge[]>;
  // Live search of the platform's categories/games, powering the "Farm only these
  // categories" picker in Settings. Returns id + name (+ box art) matches.
  searchCategories?(query: string): Promise<CategorySelection[]>;
  // Tabless (low-resource) farming. When supported, the controller drives a
  // TablessWatchController instead of opening a watch tab; the tab path stays as
  // the automatic fallback when heartbeats stop earning.
  supportsTabless?: boolean;
  createTablessWatcher?(): TablessWatchController;
  createDiscoverySignalController?(): DiscoverySignalController;
  createChannelPointsPushController?(): TwitchChannelPointsPushController;
  // Joins the watched channel's chat while presence is wanted (chatPresence.ts).
  createChatPresenceClient?(): ChatPresenceClient;
  // Whether a bounded post-claim refresh is worthwhile on this platform. Twitch
  // only reveals the next reward in a campaign chain on a subsequent inventory
  // read, so re-polling recovers watch time the fixed alarm would otherwise
  // waste. Kick's tabless watcher holds a persistent viewer socket and paces
  // its own sends, so it has no equivalent dead minute to recover.
  supportsPostClaimHandoff?: boolean;
}

export interface PageFetcher {
  flushRouteDiagnostics?(emit: EventEmitter): void;
  fetchJson<T>(url: string, init?: RequestInit, emit?: EventEmitter): Promise<T>;
}
