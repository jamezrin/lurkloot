import type { CriticalHealthState } from "./criticalHealth";

export type Platform = "twitch" | "kick";

export type WatchSourceId = "drops" | "nopixel" | "fortnite" | "watch_streaks" | "watchlist";

export type PlatformAuthStatus =
  | "checking"
  | "healthy"
  | "missing_credentials"
  | "invalid_credentials"
  | "blocked"
  | "unavailable";

export type PlatformAuthReasonCode =
  | "credentials_missing"
  | "credentials_rejected"
  | "security_policy_blocked"
  | "credential_lookup_failed"
  | "platform_unavailable"
  | "network_unavailable";

export type PlatformAuthMessageKey =
  | "authChecking"
  | "authHealthy"
  | "authMissingCredentials"
  | "authInvalidCredentials"
  | "authSecurityPolicyBlocked"
  | "authCredentialLookupFailed"
  | "authPlatformUnavailable"
  | "authNetworkUnavailable";

export interface PlatformAuthMessage {
  key: PlatformAuthMessageKey;
  values?: Partial<Record<"reference", string | number>>;
}

export interface PlatformAuthHealth {
  status: PlatformAuthStatus;
  checkedAt?: string;
  reasonCode?: PlatformAuthReasonCode;
  message?: PlatformAuthMessage;
  // The signed-in account's stable platform id, read by the auth probe on a
  // healthy check. Only a healthy health carries it; it keys per-account
  // runtime records such as watch-streak attempts.
  accountId?: string;
}

export type CampaignStatus = "active" | "upcoming" | "expired" | "completed";

export type RewardStatus = "locked" | "in_progress" | "claimable" | "claimed";

export type RewardRequirementType = "watch" | "subscription" | "action";

export interface ClaimGuidance {
  kind: "link_required";
  url: string;
}

// Lifecycle of the one-time Chrome Web Store rate/review nudge. "pending" until
// the user either rates or dismisses it, after which it never shows again.
export type RateNudgeStatus = "pending" | "rated" | "dismissed";

// Lifecycle of the one-time GitHub star nudge. "pending" until the user either
// stars or dismisses it, after which it never shows again.
export type GithubStarNudgeStatus = "pending" | "starred" | "dismissed";

export type RewardBenefitType = "UNKNOWN" | "BADGE" | "EMOTE" | "DIRECT_ENTITLEMENT" | string;

export interface RewardBenefit {
  id?: string;
  name?: string;
  imageUrl?: string;
  // Absent when the platform did not say: such a benefit stays unclassified.
  distributionType?: RewardBenefitType;
}

export interface DropReward {
  id: string;
  name: string;
  imageUrl?: string;
  benefitIds?: string[];
  // The first benefit's distribution type. Kept for campaigns stored before
  // `benefits` existed; read badges through isBadgeReward, never directly.
  benefitType?: RewardBenefitType;
  // Every benefit the reward grants, in the platform's order, with the type the
  // platform reported. Absent on campaigns stored before it existed and on
  // platforms that report no benefit types (Kick).
  benefits?: RewardBenefit[];
  requiredMinutes: number;
  requiredSubs?: number;
  isWatchBased?: boolean;
  requirement?: RewardRequirementType;
  watchedMinutes: number;
  status: RewardStatus;
  claimId?: string;
  // Identifies this reward for the signed-in account; never sent to the
  // platform. A claim stays recorded under it when a later response stops
  // reporting it. claimId cannot do that for a Twitch subscription reward, which
  // has one only while Twitch reports its drop instance.
  claimKey?: string;
  availableFrom?: string;
  availableUntil?: string;
  claimUntil?: string;
  preconditionRewardIds?: string[];
  preconditionsMet?: boolean;
  // Set by applySubscriptionMarks when the user marked this subscription
  // reward as subscribed, never by a platform parser. The reward's status stays
  // the platform's report.
  subscriptionMarked?: boolean;
  isCurrentReward?: boolean;
  claimGuidance?: ClaimGuidance;
  // A reward earned again in each window (a Twitch reward-campaign group earned
  // on three days): how many grants are in, of how many. The current grant is
  // what claimKey names, so a claim of one grant never counts for the next.
  repeat?: RewardRepeat;
  // Set when the reward sits on one lane of a track the user picks between.
  // Only the equipped lane earns; the others are action rewards.
  lane?: RewardLaneRef;
}

export interface RewardRepeat {
  grantCount: number;
  times: number;
}

export interface RewardLaneRef {
  track: string;
  lane: string;
}

// One lane the user can equip on a track, for the popup's picker.
export interface CampaignLaneOption {
  lane: string;
  name: string;
  imageUrl?: string;
  equipped: boolean;
}

export interface CampaignLaneChoice {
  track: string;
  lanes: CampaignLaneOption[];
}

// A category a campaign that spans several earns in.
export interface CampaignCategory {
  id: string;
  name: string;
}

export interface DropCampaign {
  id: string;
  platform: Platform;
  name: string;
  slug?: string;
  gameName?: string;
  gameImageUrl?: string;
  categoryId?: string;
  // Set instead of categoryId on a campaign that earns in any of several
  // categories (a Twitch reward campaign). Each one is matched on its own.
  categories?: CampaignCategory[];
  // Runs on every channel in its categories, not on channels that advertise it,
  // so no per-channel availability lookup can confirm it.
  sitewide?: boolean;
  // Who runs the campaign, shown where a game name would be. Never a category.
  brand?: string;
  laneChoices?: CampaignLaneChoice[];
  startsAt?: string;
  endsAt?: string;
  status: CampaignStatus;
  rewards: DropReward[];
  allowedChannels?: string[];
  connectionUrls?: string[];
  isGeneralDrop?: boolean;
  accountLinked?: boolean;
  accountLinkUrl?: string;
  claimGuidance?: ClaimGuidance;
  eligibility?:
    | "eligible"
    | "account_not_linked"
    | "waiting_for_subscription"
    | "upcoming"
    | "expired"
    | "completed"
    | "no_rewards";
  eligibilityReason?: string;
  priority?: number;
  url?: string;
}

// A channel's public identity, looked up from its platform id.
export interface ChannelIdentity {
  login: string;
  displayName?: string;
  imageUrl?: string;
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
  // Undefined when the platform cannot confirm campaign availability. A
  // definitive false rejects the candidate; soft failures keep the existing
  // live/category validation path usable.
  campaignMatches?: boolean;
  // An offline check that a second, independent signal agrees with, such as
  // the platform pushing that the stream ended. One such check ends the watch
  // instead of waiting for offlineRetryLimit consecutive ones.
  offlineConfirmed?: boolean;
  reason?: string;
  candidate: ChannelCandidate;
}

export interface SupplementalWatchTarget {
  id: string;
  channel: ChannelCandidate;
  tablessOnly: true;
}

export interface WatchSession {
  supplementalWatch?: { id: string; tablessOnly: true };
  platform: Platform;
  tabId?: number;
  tabManagedByExtension?: boolean;
  channel?: ChannelCandidate;
  campaignId?: string;
  rewardId?: string;
  startedAt?: string;
  // When the current watch tab was opened (or re-opened / re-navigated). Playback
  // telemetry only becomes meaningful once the page has had time to attach a
  // player, so the scheduler grants a grace period from this instant before it
  // starts counting unhealthy playback checks.
  watchTabOpenedAt?: string;
  lastCheckedAt?: string;
  offlineChecks: number;
  playbackChecks?: number;
  // Consecutive verification windows in which a healthy, category-matching watch
  // accrued no additional minutes, plus the reading they are compared against.
  // Trusting a discovery source means nothing else rejects such a channel, so
  // this is what rotates off one that never pays out (#400).
  noProgressChecks?: number;
  lastWatchedMinutes?: number;
  errorChecks?: number;
  retryAfter?: string;
  status: "idle" | "starting" | "watching" | "paused" | "error";
  message?: string;
  reasonCode?: WatchReasonCode;
  playback?: PlaybackTelemetry;
  // How the current channel is being watched. "tabless" sends API watch
  // heartbeats with no tab (low-resource mode); "tab" is the classic visible
  // muted tab. Absent means tab-based, preserving prior behavior.
  watchMode?: "tab" | "tabless";
  // True when tabless mode was wanted but we opened a tab anyway (because the
  // heartbeat kept failing). Keeps the channel on its tab until the fallback
  // expires or the channel switches.
  tablessFallback?: boolean;
  // When the current fallback began, and how many fallbacks this channel has
  // had without a healthy tabless heartbeat in between. Tabless is retried once
  // the fallback outlives a delay that doubles per attempt, up to a cap (#884).
  tablessFallbackAt?: string;
  tablessFallbackAttempts?: number;
  // Health of the tabless heartbeat. lastHeartbeatOk is whether the last watch
  // signal was accepted; heartbeatChecks counts consecutive unhealthy checks so
  // the scheduler can fall back to a real tab after tablessFallbackFailureLimit.
  lastHeartbeatAt?: string;
  lastHeartbeatOk?: boolean;
  heartbeatChecks?: number;
  tablessHeartbeat?: TablessHeartbeatCadence;
}

export interface TablessHeartbeatCadence {
  generation: number;
  contextKey: string;
  nextDueAt: string;
}

export type WatchReasonCode =
  | "supplemental_watch"
  | "eligible_campaign"
  | "watchlist_selected"
  | "no_eligible_channel"
  | "no_existing_session"
  | "manual_watch"
  | "manual_tab_close"
  | "automation_disabled"
  | "platform_disabled"
  | "authentication_unhealthy"
  | "platform_backoff"
  | "platform_error"
  | "campaign_ineligible"
  | "channel_excluded"
  | "channel_offline"
  | "channel_mismatch"
  | "watch_unhealthy"
  | "no_progress"
  | "higher_priority_reward"
  | "higher_priority_watchlist"
  | "keeping_current_watch"
  | "keeping_watchlist"
  | "watch_requirement_completed"
  | "runtime_restart"
  | "target_changed"
  | "critical_failure"
  | "permission_missing";

export interface ManagedWatchTab {
  platform: Platform;
  tabId: number;
  channelUrl: string;
  ownedByExtension: true;
}

// The watch tab a host opened for the engine (#598: watch tabs are the host's
// WatchTabPort, not the platform adapter's).
export interface PreparedWatchTab {
  tabId: number;
  managedByExtension: boolean;
  managedTab?: ManagedWatchTab;
}

// Why a tab the engine held was closed (#598). Only a `user` close is the
// user's gesture; the others are the engine's own cleanup and must never be
// read as the user closing a farming tab.
export type TabClosureOrigin = "user" | "extension-cleanup" | "extension-recovery" | "host-restart";

export interface WatchTabOptions {
  muted: boolean;
  closeManagedTabs: boolean;
  keepVideosUnmuted: boolean;
  managedTab?: ManagedWatchTab;
  signal?: AbortSignal;
  // Recorded against the tab if stopping it closes it. Defaults to
  // "extension-cleanup".
  closureOrigin?: Exclude<TabClosureOrigin, "user">;
}

export interface ManagedPageContextTab {
  platform: Platform;
  tabId: number;
  originUrl: string;
  origin: string;
  ownedByExtension: true;
  lastFallbackAt?: string;
  fallbackHost?: string;
  backgroundSuccesses?: number;
}

// The page-context tabs the engine holds, one per platform, as persisted in
// SchedulerState.managedPageContextTabs.
export type SchedulerManagedPageContexts = Partial<Record<Platform, ManagedPageContextTab>>;

// Recorded when the user closes an extension-owned watch tab. Closing the
// window LurkLoot opened is the most direct "stop" gesture available, so the
// scheduler treats it as an explicit per-platform pause until the user resumes
// from the popup. It never touches the user's enabled/running settings.
export interface ManualClosePauseState {
  platform: Platform;
  closedAt: string;
  channelUrl?: string;
}

export interface ManualWatchState {
  platform: Platform;
  tabId: number;
  checkedAt: string;
  active: boolean;
  channel?: ChannelCandidate;
}

// The one live strategy that ranks every campaign no pin or favourite game
// already placed. A strategy is always in effect: which campaigns are farmed at
// all is the reward filter's per-group choice (#932), not a mode.
export type PriorityMode = "ending_soonest" | "lowest_availability";

// Per-platform reward filter: which reward kinds a platform farms, and how
// subscription rewards are treated. A campaign is farmed toward its matching
// rewards and the rewards they wait on, so it is done once those are earned,
// whatever else it offers.
export type RewardKind = "item" | "badge" | "emote";
export type SubscriptionRewardMode = "include" | "skip" | "only";
export interface RewardFilter {
  // Reward kinds farmed from campaigns that are neither pinned nor of a
  // favourite game.
  kinds: RewardKind[];
  subscriptions: SubscriptionRewardMode;
  // Reward kinds farmed from pinned campaigns, and from campaigns of a
  // favourite game (#932). A campaign uses its Queue group's list. An empty
  // list farms nothing from that group: only pins, say, is empty favourite and
  // other lists (it replaced farmPinnedOnly in schema 12).
  pinnedKinds: RewardKind[];
  favouriteKinds: RewardKind[];
}
export type RewardFilterMiss = "kind" | "subscription";

// What a platform does with campaigns whose account is not linked:
// - "include": farm them, ranked like any other campaign;
// - "skip": never farm them (a pin does not change that);
// - "last": farm them only after every linked campaign, unless the user pinned
//   the campaign or starred its game, which keep their own rank.
export type UnlinkedCampaignMode = "include" | "skip" | "last";

// Visibility categories for the Drops list. A campaign in one of these states is
// only shown when its toggle is on; campaigns in none of them are always shown.
// Filter keys that gate farming: the engine's isEligible consults exactly these.
export type FarmingFilterKey = "notLinked" | "subscription";
// Filter keys that only decide what the Drops list shows. `excluded` is here
// deliberately: exclusion is already enforced for farming by excludedCampaignIds,
// so a farming key named `excluded` would have to mean "farm what I excluded".
export type DisplayFilterKey = "upcoming" | "expired" | "excluded" | "finished";
export type CampaignFilterKey = FarmingFilterKey | DisplayFilterKey;

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

export type SupportedLocale =
  | "en"
  | "es"
  | "fr"
  | "it"
  | "ru"
  | "de"
  | "zh_CN"
  | "hi"
  | "pt_BR"
  | "ar"
  | "tr"
  | "ja"
  | "id"
  | "pl"
  | "ko"
  | "uk"
  | "cs"
  | "fa";

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

// How `categories` is interpreted. Both modes keep the same list, so the user's
// selection survives a mode switch untouched:
// - "all": every category is farmable; the list is retained but inactive.
// - "include": only listed categories are farmed (an empty list farms nothing).
// Neither mode ranks: list position has no scheduling effect. A category the
// user wants ranked goes in favouriteCategories, and one they never want farmed
// goes in blockedCategories, which applies in both modes.
export type CategoryMode = "all" | "include";

// Chat presence (docs/superpowers/specs/2026-10-05-chat-presence-design.md):
// whether LurkLoot is in the watched channel's chat. Runtime only; attached to
// snapshots, never persisted.
export type ChatPresenceState = "left" | "joining" | "joined" | "error" | "blocked";
export type ChatPresenceBlockReason =
  | "auth"
  | "origin-rejected"
  | "unsupported-provider"
  | "capability-absent";
export interface ChatPresenceStatus {
  state: ChatPresenceState;
  channel?: string;
  reason?: ChatPresenceBlockReason;
}

export interface PlatformSettings {
  enabled: boolean;
  watchSourcePriority: WatchSourceId[];
  watchlistChannels: string[];
  excludedChannels?: string[];
  categoryMode: CategoryMode;
  // Eligibility, like categoryMode: a campaign with no reward the filter allows
  // stays listed, skipped with the reason. Per platform, as each platform has
  // its own Queue and its own reward kinds.
  rewardFilter: RewardFilter;
  // Ordered ids of this platform's campaigns the user placed by hand. Sparse by
  // design: dragging one campaign pins that campaign and leaves every other one
  // to the tiers below. Per platform since schema version 11 (#930).
  campaignPins: string[];
  // This platform's campaigns the user excluded: never farmed.
  excludedCampaignIds: string[];
  // This platform's campaigns with no linked account (real on Kick, which
  // accrues watch progress before linking): farmed, skipped or farmed last.
  unlinkedCampaigns: UnlinkedCampaignMode;
  categories: CategorySelection[];
  // Ordered. Campaigns of these categories rank above the live strategy, below
  // pinned campaigns. Purely a ranking mark: it never makes a campaign farmable
  // that eligibility rejected.
  favouriteCategories: CategorySelection[];
  // Never farmed, in either categoryMode. A blocked category keeps any star and
  // list membership it had, so unblocking restores the previous state.
  blockedCategories: CategorySelection[];
  // "<campaignId>:<rewardId>" of subscription rewards the user marked as
  // subscribed. Lurkloot then treats that reward's subscription as detected
  // (docs/superpowers/specs/2026-10-03-subscription-marks-design.md).
  subscribedRewardMarks?: string[];
  // Join the chat of every channel watched tablessly on this platform, so the
  // account appears in its chatter list. Off by default. Providers that need
  // chat presence (NoPixelV) join it regardless.
  alwaysEnterChat?: boolean;
}

// Per-platform settings carry the claim toggles that only make sense on that
// platform, so the type never advertises a knob the platform ignores.
export interface TwitchPlatformSettings extends PlatformSettings {
  autoClaimChannelPoints: boolean;
  // Advanced: require DropsHighlightService_AvailableDrops to list a campaign
  // before farming it on a channel. Off by default — see #400 and
  // TwitchAdapterOptions.strictCampaignAvailability.
  strictCampaignAvailability: boolean;
  // Advanced: claim channel-point bonuses from Twitch's live Hermes
  // notification. On by default. Off restores the one-minute ChannelPointsContext
  // alarm as the only dedicated claim trigger. See #529.
  channelPointsPushClaim: boolean;
  // Watchlist channels whose watch streak Lurkloot maintains (#897).
  // Always a subset of watchlistChannels, in no meaningful order: the
  // watchlist's own order decides. Empty by default.
  watchlistStreakChannels: string[];
  // Advanced: healthy watch time a streak attempt gets before it ends as not
  // confirmed, in minutes. A safety budget, not Twitch's own threshold.
  watchStreakBudgetMinutes: number;
  // Advanced: how long an attempt rests after a round that never played.
  watchStreakRetryCooldownMinutes: number;
  // Advanced: rounds of failed playback before an attempt ends as couldn't
  // watch. Each round can open a watch tab, so it is bounded.
  watchStreakMaxRounds: number;
}

export interface KickPlatformSettings extends PlatformSettings {
  autoClaimChallenges: boolean;
}

export interface PlatformSettingsByPlatform {
  twitch: TwitchPlatformSettings;
  kick: KickPlatformSettings;
}

export interface TwitchCompatibilitySettings {
  profile: string;
  heartbeatTransport: string;
  inventoryQueryVersion: string;
}

export interface KickCompatibilitySettings {
  profile: string;
  claimLinkHandling: string;
}

export interface CompatibilitySettings {
  twitch: TwitchCompatibilitySettings;
  kick: KickCompatibilitySettings;
}

// The universal settings contract the farming engine (packages/core) consumes.
// Host-agnostic: every field here does something during a scheduler tick on any
// host (extension or CLI). Host-only knobs (browser tab policy, popup UI) live on
// ExtensionSettings below, never here.
export interface EngineSettings {
  // There is deliberately no global `running` flag. Farming is active for a
  // platform when that platform is enabled, and nothing else — see
  // isFarmingActive(). A separate master switch used to drift out of step with
  // the per-platform flags (the popup rendered `running && enabled`, so a
  // cleared master hid still-enabled platforms and re-enabling one resurrected
  // the others), and autoStartDropFarming now expresses "do not resume on
  // restart" by clearing the per-platform flags instead.
  autoClaim: boolean;
  // Low-resource mode: farm by sending watch signals instead of opening a
  // video tab. Twitch uses API heartbeats; Kick uses a viewer WebSocket. Falls
  // back to a tab automatically if heartbeats stop earning.
  tablessMode: boolean;
  pauseOnManualWatch: boolean;
  notifyRewardEarned: boolean;
  notifyNoDropsLeft: boolean;
  autoStartDropFarming: boolean;
  /** @deprecated Compatibility input for profiles without watchSourcePriority. */
  idleWatchlistFallbackOnly: boolean;
  // Ranks Watchlist and followed channels ahead of anonymous directory
  // channels when picking who to farm a campaign on (see chooseCampaignDecision
  // in the scheduler). Off reverts to viewer-count-only ordering and skips the
  // adapter's followed-channel lookup entirely, so a platform/account that never
  // wants the extra request can turn it off.
  preferKnownChannels: boolean;
  priorityMode: PriorityMode;
  platform: PlatformSettingsByPlatform;
  compatibility: CompatibilitySettings;
  offlineRetryLimit: number;
  // Consecutive failed tabless heartbeats before falling back to a watch tab.
  tablessFallbackFailureLimit: number;
  pollIntervalMinutes: number;
  // Bounded post-claim handoff. After a reward is claimed, re-run discovery for
  // that platform on this cadence until the next eligible reward appears, then
  // transmit immediately instead of waiting for the fixed one-minute watch
  // alarm. Only platforms whose adapter sets supportsPostClaimHandoff use it.
  postClaimHandoff: boolean;
  postClaimHandoffIntervalSeconds: number;
  postClaimHandoffMaxSeconds: number;
  skipUnfinishableRewards: boolean;
  deadlineSafetyMarginMinutes: number;
  // Kill switch for the critical-failure detector and its popup prompt. On by
  // default; thresholds themselves are fixed constants in core.
  criticalFailurePromptEnabled: boolean;
}

// The browser extension's full settings schema: the engine contract plus the
// host-only knobs the engine never reads. Tab policy (mute / ad focus / auto-close
// / keep-unmuted) is supplied to the engine through the injected WatchTabPort and
// applyAdFocus, not read from settings by the engine; popup UI state (i18n, rate
// nudge) is pure host state.
export type TwitchExtensionProviderId = "nopixel" | "fortnite";
export type TwitchExtensionStatus =
  | "idle"
  | "discovering"
  | "connecting"
  | "farming"
  | "complete"
  | "unavailable"
  | "error";
export type TwitchExtensionReasonCode =
  | "disabled"
  | "permission-required"
  | "auth-required"
  | "identity-required"
  // `not-installed`: the watched channel doesn't have the provider's extension
  // at all; `channel-ineligible` is the vendor's own answer (#728).
  | "channel-required"
  | "not-installed"
  | "channel-ineligible"
  | "channel-not-connected"
  | "watchtime"
  | "giveaway"
  | "collecting"
  | "phase-closed"
  | "rewards-complete"
  | "transport-error"
  | "compatibility-error"
  | "provider-error"
  | "connecting";
export interface TwitchExtensionReport {
  status: TwitchExtensionStatus;
  reasonCode: TwitchExtensionReasonCode;
  progress: {
    key: "daily-pack" | "phase-captures" | "phase-score" | "rewards";
    earned: number;
    required: number;
  }[];
  pending: {
    key: "giveaway" | "participation" | "completion" | "takeover" | "account-link";
    state: "open" | "done" | "blocked";
  }[];
}
export interface TwitchExtensionSummary extends TwitchExtensionReport {
  channel?: { username: string; displayName?: string };
  updatedAt: string;
  retryAfter?: string;
}
export interface TwitchExtensionsSettings {
  nopixel: { enabled: boolean; autoOpenPacks: boolean };
  fortnite: { enabled: boolean; allowTakeovers: boolean };
}

export interface ExtensionSettings extends EngineSettings {
  twitchExtensions: TwitchExtensionsSettings;
  // Number of committed Kick scheduler cycles using direct background fetches
  // required before an extension-owned fallback page is closed.
  kickPageContextRecoverySuccesses: number;
  muteFarmingTabs: boolean;
  keepFarmingVideosUnmuted: boolean;
  autoCloseFinishedDrops: boolean;
  adFocusMode: AdFocusMode;
  languageOverride: LanguageOverride;
  rateNudgeStatus: RateNudgeStatus;
  githubStarNudgeStatus: GithubStarNudgeStatus;
  showTips: boolean;
  // Extension-only persistence policy. Normal farming activity is always
  // recorded; this opt-in adds lower-level technical diagnostics.
  diagnosticLogging: boolean;
  // Shows a Lurkloot button on twitch.tv/kick.com that opens the popup in a
  // draggable panel on the page. On by default, despite injecting UI into a
  // site the user did not ask us to change: the feature exists for people who
  // do not pin the extension and find the toolbar popup awkward to reach, and
  // gating it behind a toggle *inside that popup* would only ever reach the
  // people who already open it comfortably.
  showInPagePanel: boolean;
}

export interface SchedulerState {
  // Host transient summaries are attached to snapshots, not restored as an
  // active provider session. Provider credentials never belong in this state.
  twitchExtensions?: Partial<Record<TwitchExtensionProviderId, TwitchExtensionSummary>>;
  // Live chat presence per platform, attached to snapshots like the
  // twitchExtensions summaries. Never persisted or restored.
  chatPresence?: Partial<Record<Platform, ChatPresenceStatus>>;
  sessions: Record<Platform, WatchSession>;
  authHealth: Record<Platform, PlatformAuthHealth>;
  // Per-platform critical-failure detection. Persisted so the flag survives an
  // MV3 service-worker restart; its counters are reset on restore.
  criticalHealth?: Partial<Record<Platform, CriticalHealthState>>;
  managedWatchTabs?: Partial<Record<Platform, ManagedWatchTab>>;
  managedPageContextTabs?: Partial<Record<Platform, ManagedPageContextTab>>;
  manualWatch?: Partial<Record<Platform, ManualWatchState>>;
  manualWatchTabs?: Partial<Record<Platform, Record<string, ManualWatchState>>>;
  // Platforms paused because the user manually closed their managed watch tab.
  // Cleared only by an explicit resume from the popup/CLI host.
  manualClosePause?: Partial<Record<Platform, ManualClosePauseState>>;
  // Last time each platform's account-level gamification endpoints were polled.
  // Persisted because adapters are rebuilt every tick, so an in-memory throttle
  // would never survive to the next one.
  gamification?: Partial<Record<Platform, { lastCheckedAt: string }>>;
  // The open farming session per platform: from the platform's farming being
  // enabled until it is disabled, surviving restarts. Written only by the
  // controller's farming-session reconcile (settings commits and startup).
  farmingSessions?: Partial<Record<Platform, { id: string; startedAt: string }>>;
  // The signed-in account's own progress on its platform, polled on its own
  // stamp (independent of challenge claiming) and shown beside the platform's
  // switch. `progress` is the last good read: a failed poll only moves the stamp.
  accountProgress?: Partial<Record<Platform, AccountProgressPoll>>;
  campaignSearchBackoffs?: Partial<Record<Platform, CampaignSearchBackoff>>;
  campaigns: Record<Platform, DropCampaign[]>;
  deadlineInfeasibleRewardIds?: Partial<Record<Platform, string[]>>;
  // Watch-streak maintenance attempts (#897). Runtime only: never exported
  // with the settings, pruned on every write.
  watchStreaks?: Partial<Record<Platform, WatchStreakState>>;
  lastTickAt?: string;
  // ISO timestamp recorded once by the background on install; drives the
  // time-based rate/review nudge. Undefined means "unknown" (pre-feature state).
  installedAt?: string;
}

// Account progress is whatever a platform itself tracks for the viewer, so each
// platform gets its own member with its own semantics; nothing outside that
// platform's adapter and its popup view reads the fields. Kick: the global
// viewer level earned by watch time, and the daily watch streak.
export interface KickAccountProgress {
  platform: "kick";
  level: number;
  // XP earned inside the current level, and still needed to reach the next.
  progressXp: number;
  xpToNextLevel: number;
  // Undefined when the streak could not be read; the level still stands.
  streakDays?: number;
}

export type PlatformAccountProgress = KickAccountProgress;

export interface AccountProgressPoll {
  // Stamped on every attempt, so a failing endpoint is retried on the next
  // interval rather than on every tick.
  lastCheckedAt: string;
  progress?: PlatformAccountProgress;
  // When `progress` was read.
  fetchedAt?: string;
}

export interface CampaignSearchBackoff {
  campaignId: string;
  retryAt: string;
  fingerprint: string;
}

export interface WatchDecision {
  platform: Platform;
  action: "watch" | "fallback" | "idle";
  campaign?: DropCampaign;
  reward?: DropReward;
  channel?: ChannelCandidate;
  reason: string;
  reasonCode: WatchReasonCode;
}

// Watch-streak maintenance (#897, packages/core/src/core/watchStreaks.ts). One
// attempt per signed-in account, channel and broadcast. A terminal outcome
// stays terminal for that broadcast; a new broadcast gets a new attempt.
// "credited": the platform reported the streak payout for this broadcast.
// "not_confirmed": the watch budget ran out without that report.
// "playback_failed": every round ran out of healthy checks before the budget
// was watched (#942), so the streak was never really attempted.
// None claims anything about the user's streak count.
export type WatchStreakOutcome = "pending" | "credited" | "not_confirmed" | "playback_failed";

export interface WatchStreakAttempt {
  accountId: string;
  channelId: string;
  broadcastId: string;
  // Lowercased login, for display only. Identity is the ids above.
  username: string;
  outcome: WatchStreakOutcome;
  // Healthy watching observed by the engine, in milliseconds.
  watchedMs: number;
  // Ticks in the current round that found this attempt's channel selected but
  // not healthy. Reset when the round ends.
  unhealthyChecks: number;
  // Rounds that ran out of healthy checks. Never reset, so merges and restarts
  // keep the bound.
  failedRounds: number;
  // When a round ran out of healthy checks: the attempt rests until then.
  retryAt?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

// What the popup shows beside a maintained Watchlist row.
export type WatchStreakRowStatus =
  | "pending"
  | "watching"
  | "credited"
  | "not_confirmed"
  | "playback_failed"
  | "unavailable";

export interface WatchStreakState {
  attempts: WatchStreakAttempt[];
  // The attempt whose healthy watch was last observed, and when. Elapsed time
  // is only counted from this stamp, so a suspended worker, a pause or a
  // switch away never counts.
  observing?: { key: string; at: string };
  // Last status of each maintained row, written by the tick for the popup.
  rows?: Record<string, WatchStreakRowStatus>;
  // Whether this host can observe the streak payout at all, as of the last
  // tick. Undefined until a tick has run.
  observerAvailable?: boolean;
}
