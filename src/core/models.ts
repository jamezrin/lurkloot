import type { LogLevel } from "./logging";

export type Platform = "twitch" | "kick";

export type CampaignStatus = "active" | "upcoming" | "expired" | "completed";

export type RewardStatus = "locked" | "in_progress" | "claimable" | "claimed";

export interface DropReward {
  id: string;
  name: string;
  imageUrl?: string;
  benefitIds?: string[];
  benefitType?: "UNKNOWN" | "BADGE" | "EMOTE" | "DIRECT_ENTITLEMENT" | string;
  requiredMinutes: number;
  requiredSubs?: number;
  watchedMinutes: number;
  status: RewardStatus;
  claimId?: string;
  availableFrom?: string;
  availableUntil?: string;
  claimUntil?: string;
  preconditionRewardIds?: string[];
  preconditionsMet?: boolean;
  isCurrentReward?: boolean;
}

export interface DropCampaign {
  id: string;
  platform: Platform;
  name: string;
  slug?: string;
  gameName?: string;
  gameImageUrl?: string;
  categoryId?: string;
  startsAt?: string;
  endsAt?: string;
  status: CampaignStatus;
  rewards: DropReward[];
  allowedChannels?: string[];
  connectionUrls?: string[];
  isGeneralDrop?: boolean;
  accountLinked?: boolean;
  accountLinkUrl?: string;
  eligibility?: "eligible" | "account_not_linked" | "upcoming" | "expired" | "completed" | "no_rewards";
  eligibilityReason?: string;
  priority?: number;
  url?: string;
}

export interface ChannelCandidate {
  platform: Platform;
  username: string;
  displayName?: string;
  url: string;
  campaignId?: string;
  categoryId?: string;
  categoryName?: string;
  isAclMatch?: boolean;
  viewerCount?: number;
  title?: string;
  live?: boolean;
  profileImageUrl?: string;
  // Identifiers the tabless watcher needs to send watch heartbeats without a
  // tab. Populated by checkChannel when available: broadcastId is the Twitch
  // stream id (or Kick livestream id), channelId is the channel's user id.
  broadcastId?: string;
  channelId?: string;
}

export interface ChannelCheck {
  live: boolean;
  categoryMatches: boolean;
  reason?: string;
  candidate: ChannelCandidate;
}

export interface WatchSession {
  platform: Platform;
  tabId?: number;
  tabManagedByExtension?: boolean;
  channel?: ChannelCandidate;
  campaignId?: string;
  rewardId?: string;
  startedAt?: string;
  lastCheckedAt?: string;
  offlineChecks: number;
  playbackChecks?: number;
  errorChecks?: number;
  retryAfter?: string;
  status: "idle" | "watching" | "paused" | "error";
  message?: string;
  playback?: PlaybackTelemetry;
  // How the current channel is being watched. "tabless" sends API watch
  // heartbeats with no tab (low-resource mode); "tab" is the classic visible
  // muted tab. Absent means tab-based, preserving prior behavior.
  watchMode?: "tab" | "tabless";
  // True when tabless mode was wanted but we opened a tab anyway (because the
  // heartbeat kept failing). Keeps the channel on its tab until it switches.
  tablessFallback?: boolean;
  // Health of the tabless heartbeat. lastHeartbeatOk is whether the last watch
  // signal was accepted; heartbeatChecks counts consecutive unhealthy checks so
  // the scheduler can fall back to a real tab after offlineRetryLimit.
  lastHeartbeatAt?: string;
  lastHeartbeatOk?: boolean;
  heartbeatChecks?: number;
}

export interface ManagedWatchTab {
  platform: Platform;
  tabId: number;
  channelUrl: string;
  ownedByExtension: true;
}

export interface ManagedPageContextTab {
  platform: Platform;
  tabId: number;
  originUrl: string;
  origin: string;
  ownedByExtension: true;
}

export interface ManualWatchState {
  platform: Platform;
  tabId: number;
  checkedAt: string;
  active: boolean;
}

export type PriorityMode = "ending_soonest" | "lowest_availability" | "priority_list_only";

export interface PlaybackTelemetry {
  platform: Platform;
  checkedAt: string;
  videoCount: number;
  mutedVideoCount: number;
  unmutedVideoCount: number;
  playingVideoCount: number;
  blockedPlaybackCount: number;
  documentHidden: boolean;
  adActive?: boolean;
  readyState?: number;
  currentTime?: number;
  duration?: number;
}

// How aggressively the managed watch tab is brought to focus while an ad is
// rolling, so the ad countdown (driven by requestAnimationFrame, which the
// browser throttles in background tabs/windows) keeps progressing.
export type AdFocusMode = "none" | "tab" | "window";

export interface PlatformSettings {
  enabled: boolean;
  watchQueueChannels: string[];
  excludedChannels?: string[];
  gamePriority?: string[];
}

export interface ExtensionSettings {
  running: boolean;
  autoClaim: boolean;
  autoClaimChannelPoints: boolean;
  // Opt-in low-resource mode: farm by sending API watch heartbeats instead of
  // opening a video tab. Twitch is fully tabless; Kick uses a viewer WebSocket.
  // Falls back to a tab automatically if heartbeats stop earning.
  tablessMode: boolean;
  muteFarmingTabs: boolean;
  keepFarmingVideosUnmuted: boolean;
  pauseOnManualWatch: boolean;
  adFocusMode: AdFocusMode;
  autoCloseFinishedDrops: boolean;
  notifyRewardEarned: boolean;
  notifyNoDropsLeft: boolean;
  autoStartDropFarming: boolean;
  watchQueueFallbackOnly: boolean;
  priorityMode: PriorityMode;
  platform: Record<Platform, PlatformSettings>;
  campaignPriorities: Record<string, number>;
  excludedCampaignIds: string[];
  offlineRetryLimit: number;
  pollIntervalMinutes: number;
  enabledLogLevels: LogLevel[];
}

export interface EventLogEntry {
  id: string;
  at: string;
  platform?: Platform;
  level: LogLevel;
  message: string;
}

export interface PlatformDiagnostics {
  platform: Platform;
  checkedAt: string;
  ok: boolean;
  campaignCount: number;
  eligibleCampaignCount: number;
  candidateCount: number;
  checkedChannel?: ChannelCheck;
  message: string;
}

export interface SchedulerState {
  sessions: Record<Platform, WatchSession>;
  managedWatchTabs?: Partial<Record<Platform, ManagedWatchTab>>;
  managedPageContextTabs?: Partial<Record<Platform, ManagedPageContextTab>>;
  manualWatch?: Partial<Record<Platform, ManualWatchState>>;
  campaigns: Record<Platform, DropCampaign[]>;
  diagnostics?: Partial<Record<Platform, PlatformDiagnostics>>;
  events: EventLogEntry[];
  lastTickAt?: string;
}

export interface WatchDecision {
  platform: Platform;
  action: "watch" | "fallback" | "idle";
  campaign?: DropCampaign;
  reward?: DropReward;
  channel?: ChannelCandidate;
  reason: string;
}
