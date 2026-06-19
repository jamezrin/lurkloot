import type { LogLevel } from "./logging";

export type Platform = "twitch" | "kick";

export type CampaignStatus = "active" | "upcoming" | "expired" | "completed";

export type RewardStatus = "locked" | "in_progress" | "claimable" | "claimed";

// Lifecycle of the one-time Chrome Web Store rate/review nudge. "pending" until
// the user either rates or dismisses it, after which it never shows again.
export type RateNudgeStatus = "pending" | "rated" | "dismissed";

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

// Visibility categories for the Drops list. A campaign in one of these states is
// only shown when its toggle is on; campaigns in none of them are always shown.
export type CampaignFilterKey = "notLinked" | "upcoming" | "expired" | "excluded" | "finished";

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

export type SupportedLocale = "en" | "es" | "fr" | "it" | "ru" | "de" | "zh_CN" | "hi" | "pt_BR" | "ar";

export type LanguageOverride = "browser" | SupportedLocale;

// A category (Twitch/Kick call it a game/category) the user has picked to farm.
// We store the name alongside the id because a picked category may not appear in
// any current campaign, so the UI must render it without one. `id` matches the
// platform's category/game id; `name` is matched too as a fallback.
export interface CategorySelection {
  id: string;
  name: string;
  imageUrl?: string;
}

export interface PlatformSettings {
  enabled: boolean;
  watchQueueChannels: string[];
  excludedChannels?: string[];
  // When true, every category is farmable. When false, only `categories` are
  // farmed (an empty list then means nothing is farmed). The list is ordered:
  // order sets farming priority (see categoryPriorityScore in the scheduler).
  farmAllCategories: boolean;
  categories: CategorySelection[];
}

// The universal settings contract the farming engine (packages/core) consumes.
// Host-agnostic: every field here does something during a scheduler tick on any
// host (extension or CLI). Host-only knobs (browser tab policy, popup UI) live on
// ExtensionSettings below, never here.
export interface EngineSettings {
  running: boolean;
  autoClaim: boolean;
  autoClaimChannelPoints: boolean;
  // Low-resource mode: farm by sending watch signals instead of opening a
  // video tab. Twitch uses API heartbeats; Kick uses a viewer WebSocket. Falls
  // back to a tab automatically if heartbeats stop earning.
  tablessMode: boolean;
  pauseOnManualWatch: boolean;
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

// The browser extension's full settings schema: the engine contract plus the
// host-only knobs the engine never reads. Tab policy (mute / ad focus / auto-close
// / keep-unmuted) is supplied to the engine through the injected WatchTabPort and
// applyAdFocus, not read from settings by the engine; popup UI state (i18n, Drops
// filter, rate nudge) is pure host state.
export interface ExtensionSettings extends EngineSettings {
  muteFarmingTabs: boolean;
  keepFarmingVideosUnmuted: boolean;
  autoCloseFinishedDrops: boolean;
  adFocusMode: AdFocusMode;
  languageOverride: LanguageOverride;
  // Which campaign states are shown in the Drops list. See CampaignFilterKey.
  campaignVisibility: Record<CampaignFilterKey, boolean>;
  rateNudgeStatus: RateNudgeStatus;
}

export interface EventLogEntry {
  id: string;
  at: string;
  platform?: Platform;
  level: LogLevel;
  message: string;
}

export interface SchedulerState {
  sessions: Record<Platform, WatchSession>;
  managedWatchTabs?: Partial<Record<Platform, ManagedWatchTab>>;
  managedPageContextTabs?: Partial<Record<Platform, ManagedPageContextTab>>;
  manualWatch?: Partial<Record<Platform, ManualWatchState>>;
  campaigns: Record<Platform, DropCampaign[]>;
  events: EventLogEntry[];
  lastTickAt?: string;
  // ISO timestamp recorded once by the background on install; drives the
  // time-based rate/review nudge. Undefined means "unknown" (pre-feature state).
  installedAt?: string;
}

export interface WatchDecision {
  platform: Platform;
  action: "watch" | "fallback" | "idle";
  campaign?: DropCampaign;
  reward?: DropReward;
  channel?: ChannelCandidate;
  reason: string;
}
