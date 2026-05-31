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
}

export interface ManagedWatchTab {
  platform: Platform;
  tabId: number;
  channelUrl: string;
  ownedByExtension: true;
}

export type PriorityMode = "ending_soonest" | "lowest_availability";

export interface PlaybackTelemetry {
  platform: Platform;
  checkedAt: string;
  videoCount: number;
  mutedVideoCount: number;
  playingVideoCount: number;
  blockedPlaybackCount: number;
  documentHidden: boolean;
  readyState?: number;
  currentTime?: number;
  duration?: number;
}

export interface PlatformSettings {
  enabled: boolean;
  watchQueueChannels: string[];
  gamePriority?: string[];
}

export interface ExtensionSettings {
  running: boolean;
  autoClaim: boolean;
  autoClaimChannelPoints: boolean;
  muteFarmingTabs: boolean;
  pauseOnManualWatch: boolean;
  autoCloseFinishedDrops: boolean;
  notifyRewardEarned: boolean;
  notifyNoDropsLeft: boolean;
  autoStartDropFarming: boolean;
  watchQueueFallbackOnly: boolean;
  priorityMode: PriorityMode;
  platform: Record<Platform, PlatformSettings>;
  campaignPriorities: Record<string, number>;
  excludedCampaignIds: string[];
  excludedChannels: string[];
  offlineRetryLimit: number;
  pollIntervalMinutes: number;
}

export interface EventLogEntry {
  id: string;
  at: string;
  platform?: Platform;
  level: "info" | "warn" | "error";
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
