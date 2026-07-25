import type { PlatformAdapter } from "../platforms/adapter";
import type {
  ChannelCandidate,
  DropCampaign,
  DropReward,
  EngineSettings,
  Platform,
  SchedulerState,
  WatchDecision,
  WatchReasonCode,
  WatchSession,
} from "@lurkloot/shared/models";
import { categoryListIndex } from "@lurkloot/shared/categories";
import { campaignPassesFarmingEligibility, hasCampaignEnded } from "@lurkloot/shared/campaignFilters";
import { isSubscriptionReward, isWatchReward, reconcileCampaignAfterClaims, rewardFeasibility } from "@lurkloot/shared/rewards";
import { autoClaimChallengesFor, autoClaimChannelPointsFor } from "@lurkloot/shared/settings";
import type { EngineEvent, EventEmitter, FarmingStopReason, PageContextCloseReason } from "@lurkloot/shared/events";
import { currentManagedPageContextTabs, forgetManagedPageContextTabs, registerManagedPageContextTabs, type SchedulerManagedPageContexts } from "./tabs";
import type { LogLevel } from "@lurkloot/shared/logging";
import { authHealthFromError, isSafeFetchError } from "./fetchError";
import { applyPlatformAuthHealth } from "./authHealth";
import type { CriticalHealthObservation } from "./criticalHealth";
import { observeCriticalHealth } from "./criticalHealth";

const PLATFORMS: Platform[] = ["twitch", "kick"];
const MAX_PLATFORM_BACKOFF_MINUTES = 30;
export const MANUAL_WATCH_TTL_MS = 20_000;

// Kick's daily challenge window is hours long, so a ten-minute poll is far more
// than responsive enough while keeping the request count negligible.
const CHALLENGE_POLL_INTERVAL_MS = 10 * 60 * 1000;

function challengePollDue(state: SchedulerState, platform: Platform, now: number): boolean {
  const lastCheckedAt = state.gamification?.[platform]?.lastCheckedAt;
  if (!lastCheckedAt) return true;
  const last = Date.parse(lastCheckedAt);
  // A stamp in the future means the clock moved backwards (NTP correction, a
  // suspended VM). Treat it as stale rather than letting it suppress claiming
  // until the clock catches up.
  if (!Number.isFinite(last) || last > now) return true;
  return now - last >= CHALLENGE_POLL_INTERVAL_MS;
}

function activeReward(campaign: DropCampaign, settings: EngineSettings): DropReward | undefined {
  const earnable = campaign.rewards.filter((reward) =>
    reward.preconditionsMet !== false
    && isRewardAvailableToEarn(reward)
    && isRewardDeadlineFeasible(campaign, reward, settings));
  return earnable.find((reward) => reward.status === "in_progress")
    ?? earnable.find((reward) => reward.status === "locked");
}

// Decides whether to farm this channel without a tab. Off unless tabless mode is
// enabled and the platform supports it; falls back to a tab (returns false) when
// we deliberately switched to a tab for this same channel, or when tabless
// heartbeats have been failing past the retry limit.
function chooseTablessWatch(
  previous: WatchSession,
  settings: EngineSettings,
  adapter: Pick<PlatformAdapter, "supportsTabless">,
  sameChannel: boolean,
): boolean {
  if (!settings.tablessMode || !adapter.supportsTabless) return false;
  if (sameChannel && previous.watchMode === "tab" && previous.tablessFallback) return false;
  if (sameChannel && previous.watchMode === "tabless" && (previous.heartbeatChecks ?? 0) >= settings.offlineRetryLimit) return false;
  return true;
}

function isEligible(campaign: DropCampaign, settings: EngineSettings): boolean {
  if (campaign.status !== "active") return false;
  if (hasCampaignEnded(campaign)) return false;
  if (campaign.eligibility && campaign.eligibility !== "eligible") return false;
  if (settings.excludedCampaignIds.includes(campaign.id)) return false;
  // Farming eligibility: the two flags farmUnlinkedCampaigns and
  // farmSubscriptionCampaigns gate whether unlinked or subscription-gated
  // campaigns are farmed. The display-only dropsListFilter is never consulted
  // here, so hiding finished campaigns in the popup never stops farming.
  if (!campaignPassesFarmingEligibility(campaign, settings.farmingEligibility)) return false;
  // Category filter: when "Farm all categories" is off for this platform, only
  // campaigns whose category is on the list are farmable (an empty list then
  // farms nothing).
  const platformSettings = settings.platform[campaign.platform];
  if (!platformSettings.farmAllCategories && categoryListIndex(campaign, platformSettings.categories) === -1) return false;
  // Twitch cannot earn drops until the account is linked, so an unlinked Twitch
  // campaign is skipped. Kick DOES accrue watch progress before linking (the
  // link is only required to claim), so we keep farming unlinked Kick campaigns
  // and surface the claim-time "link your account" guidance instead.
  if (campaign.platform !== "kick" && campaign.accountLinked === false) return false;
  // "Priority list only" farms exclusively the campaigns the user explicitly
  // reordered (campaignPriorities). Category curation is owned by the separate
  // per-platform "Farm all categories" filter above.
  if (settings.priorityMode === "priority_list_only" && !isInPriorityList(campaign, settings)) return false;
  return campaign.rewards.some((reward) =>
    reward.status !== "claimed"
    && reward.preconditionsMet !== false
    && isRewardRelevantNow(reward)
    && (canClaimReward(reward) || isRewardDeadlineFeasible(campaign, reward, settings)));
}

// Reason codes that mean the watch stopped accruing for an explainable reason
// rather than because the extension is broken. The detector treats them as
// evidence the platform is NOT in a continuous no-value episode, so a channel
// going offline or a target switch never counts towards the critical prompt.
const ACCRUAL_PRECONDITION_BREAK_REASONS = new Set<WatchReasonCode>([
  "channel_offline",
  "channel_mismatch",
  "watch_unhealthy",
  "manual_watch",
  "target_changed",
  "higher_priority_reward",
  "higher_priority_idle_watchlist",
]);

function preconditionBreakObservation(): CriticalHealthObservation {
  return { at: Date.now(), failing: false, progressed: false, preconditionBroke: true };
}

// The tick reached no conclusion about this platform. Not "healthy": it carries no
// watchedMinutes and no record, it only keeps the detector's clock and its
// time-based pruning running.
function neutralObservation(): CriticalHealthObservation {
  return { at: Date.now(), failing: false, progressed: false, preconditionBroke: false };
}

// A failing observation with a breadcrumb built from a SafeFetchError when the
// error is one, and from the plain message otherwise.
function apiErrorObservation(error: unknown): CriticalHealthObservation {
  const failure = isSafeFetchError(error) ? error.failure : undefined;
  return {
    at: Date.now(),
    failing: true,
    progressed: false,
    preconditionBroke: false,
    record: {
      kind: "api_error",
      code: failure?.kind ?? "unknown_error",
      ...(failure?.status === undefined ? {} : { status: failure.status }),
      detail: error instanceof Error ? error.message : String(error),
    },
  };
}

// The reward the session claims to be watching, if it is still present in the
// freshly-read campaign list. Returns undefined when nothing is being farmed,
// which the detector reads as "no watch session sustained".
function activeRewardFor(campaigns: readonly DropCampaign[], session: WatchSession): DropReward | undefined {
  if (session.status !== "watching" || !session.campaignId || !session.rewardId) return undefined;
  const campaign = campaigns.find((candidate) => candidate.id === session.campaignId);
  return campaign?.rewards.find((reward) => reward.id === session.rewardId);
}

function isInPriorityList(campaign: DropCampaign, settings: EngineSettings): boolean {
  return settings.campaignPriorities[campaign.id] != null;
}

function availabilityScore(campaign: DropCampaign): number {
  if (campaign.allowedChannels?.length) return campaign.allowedChannels.length;
  return Number.MAX_SAFE_INTEGER;
}

function endScore(campaign: DropCampaign): number {
  return campaign.endsAt ? Date.parse(campaign.endsAt) : Number.MAX_SAFE_INTEGER;
}

export function sortCampaigns(campaigns: DropCampaign[], settings: EngineSettings): DropCampaign[] {
  return [...campaigns].sort((left, right) => {
    const leftPriority = settings.campaignPriorities[left.id] ?? left.priority;
    const rightPriority = settings.campaignPriorities[right.id] ?? right.priority;
    if (leftPriority != null && rightPriority != null && leftPriority !== rightPriority) return rightPriority - leftPriority;
    if (leftPriority != null && rightPriority == null) return -1;
    if (rightPriority != null && leftPriority == null) return 1;

    const categoryOrder = categoryPriorityScore(left, settings) - categoryPriorityScore(right, settings);
    if (categoryOrder !== 0) return categoryOrder;

    const normalizedLeftPriority = leftPriority ?? 0;
    const normalizedRightPriority = rightPriority ?? 0;
    if (normalizedLeftPriority !== normalizedRightPriority) return normalizedRightPriority - normalizedLeftPriority;

    if (settings.priorityMode === "lowest_availability") {
      const availability = availabilityScore(left) - availabilityScore(right);
      if (availability !== 0) return availability;
    }

    const ends = endScore(left) - endScore(right);
    if (ends !== 0) return ends;
    return left.name.localeCompare(right.name);
  });
}

// Order within the per-platform categories list sets farming priority — but only
// while the filter is active. When "Farm all categories" is on the (hidden) list
// must never silently reorder, so every campaign scores equal.
function categoryPriorityScore(campaign: DropCampaign, settings: EngineSettings): number {
  const platformSettings = settings.platform[campaign.platform];
  if (platformSettings.farmAllCategories) return Number.MAX_SAFE_INTEGER;
  const index = categoryListIndex(campaign, platformSettings.categories);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export async function chooseCampaignDecision(
  platform: Platform,
  campaigns: DropCampaign[],
  settings: EngineSettings,
  adapter: Pick<PlatformAdapter, "listCandidateChannels" | "checkChannel">,
): Promise<WatchDecision> {
  const sorted = sortCampaigns(campaigns.filter((campaign) => isEligible(campaign, settings)), settings);
  const noCampaignReason = noEligibleCampaignReason(campaigns, settings);
  const waitingForSubscription = onlyWaitingSubscriptionCampaigns(campaigns, settings);
  const subscriptionOnly = onlySubscriptionCampaigns(campaigns, settings);

  for (const campaign of sorted) {
    const reward = activeReward(campaign, settings);
    if (!reward) continue;

    const excludedChannels = settings.platform[platform].excludedChannels ?? [];
    const candidates = (await adapter.listCandidateChannels(campaign))
      .filter((candidate) => !excludedChannels.includes(candidate.username.toLowerCase()))
      .sort((left, right) => {
        if (left.isAclMatch !== right.isAclMatch) return left.isAclMatch ? -1 : 1;
        return (right.viewerCount ?? 0) - (left.viewerCount ?? 0);
      });

    const channel = await firstValidCandidate(candidates, campaign, adapter);
    if (channel) {
      return {
        platform,
        action: "watch",
        campaign,
        reward,
        channel,
        reason: "Eligible campaign selected",
        reasonCode: "eligible_campaign",
      };
    }
  }

  if (subscriptionOnly) {
    return {
      platform,
      action: "idle",
      reason: noCampaignReason,
      reasonCode: "campaign_ineligible",
    };
  }

  const fallbackCandidates = settings.platform[platform].idleWatchlistChannels
    .map((username) => username.trim().toLowerCase())
    .filter(Boolean)
    .map((username) => fallbackChannel(platform, username));
  const fallback = await firstValidCandidate(fallbackCandidates, undefined, adapter);

  if (fallback) {
    return {
      platform,
      action: "fallback",
      channel: fallback,
      reason: `${noCampaignReason}; Idle Watchlist channel selected`,
      reasonCode: "idle_watchlist_selected",
    };
  }

  return {
    platform,
    action: "idle",
    reason: `${noCampaignReason} and no Idle Watchlist channels`,
    reasonCode: waitingForSubscription ? "campaign_ineligible" : "no_eligible_channel",
  };
}

function noEligibleCampaignReason(campaigns: DropCampaign[], settings: EngineSettings): string {
  if (campaigns.length === 0) return "No campaigns discovered";
  const notExcluded = campaigns.filter((campaign) => !settings.excludedCampaignIds.includes(campaign.id));
  if (notExcluded.length === 0) return "All campaigns are excluded";
  if (notExcluded.every((campaign) => campaign.status === "upcoming" || campaign.eligibility === "upcoming")) {
    return "Only upcoming campaigns are available";
  }
  if (notExcluded.every((campaign) => campaign.status === "expired" || campaign.eligibility === "expired")) {
    return "Only expired campaigns are available";
  }
  if (notExcluded.every((campaign) => campaign.status === "completed" || campaign.eligibility === "completed")) {
    return "All campaigns are completed";
  }
  if (onlyWaitingSubscriptionCampaigns(campaigns, settings)) {
    return "Waiting for a qualifying subscription";
  }
  if (notExcluded.every((campaign) => campaign.eligibility === "no_rewards" || campaign.rewards.length === 0)) {
    return "Campaigns have no time-based rewards";
  }
  // Placed before the account-linked reason so a user who turned
  // farmUnlinkedCampaigns off is told about their eligibility setting rather
  // than about the link state that setting keys off. With the flag on, unlinked
  // campaigns pass this predicate and the more specific reason below still wins.
  if (notExcluded.every((campaign) => !campaignPassesFarmingEligibility(campaign, settings.farmingEligibility))) {
    return "All campaigns are skipped by your farming eligibility settings";
  }
  if (notExcluded.every((campaign) => campaign.accountLinked === false || campaign.eligibility === "account_not_linked")) {
    return "Campaign accounts are not linked";
  }
  if (notExcluded.every((campaign) => {
    const platformSettings = settings.platform[campaign.platform];
    return !platformSettings.farmAllCategories && categoryListIndex(campaign, platformSettings.categories) === -1;
  })) {
    return "No campaigns match the categories filter";
  }
  if (settings.priorityMode === "priority_list_only" && !notExcluded.some((campaign) => isInPriorityList(campaign, settings))) {
    return "No prioritized campaigns are eligible";
  }
  const relevantCampaigns = notExcluded.filter((campaign) => campaign.status === "active" && !hasCampaignEnded(campaign));
  if (relevantCampaigns.length > 0 && relevantCampaigns.every((campaign) =>
    campaign.rewards.some((reward) => reward.preconditionsMet !== false && isRewardAvailableToEarn(reward))
    && !campaign.rewards.some((reward) =>
      reward.preconditionsMet !== false
      && isRewardAvailableToEarn(reward)
      && isRewardDeadlineFeasible(campaign, reward, settings)))) {
    return "Available rewards cannot be completed before their deadline";
  }
  return "No eligible campaigns";
}

function onlyWaitingSubscriptionCampaigns(campaigns: DropCampaign[], settings: EngineSettings): boolean {
  const notExcluded = campaigns.filter((campaign) => !settings.excludedCampaignIds.includes(campaign.id));
  return notExcluded.length > 0 && notExcluded.every((campaign) =>
    campaign.eligibility === "waiting_for_subscription"
    && campaign.rewards.length > 0
    && campaign.rewards.every(isSubscriptionReward));
}

function onlySubscriptionCampaigns(campaigns: DropCampaign[], settings: EngineSettings): boolean {
  const notExcluded = campaigns.filter((campaign) => !settings.excludedCampaignIds.includes(campaign.id));
  return notExcluded.length > 0 && notExcluded.every((campaign) => {
    const remainingRewards = campaign.rewards.filter((reward) =>
      reward.status !== "claimed" && reward.status !== "claimable");
    return remainingRewards.length > 0 && remainingRewards.every(isSubscriptionReward);
  });
}

async function firstValidCandidate(
  candidates: ChannelCandidate[],
  campaign: DropCampaign | undefined,
  adapter: Pick<PlatformAdapter, "checkChannel">,
): Promise<ChannelCandidate | undefined> {
  for (const candidate of candidates) {
    const check = await adapter.checkChannel(candidate, campaign);
    if (check.live && check.categoryMatches && check.campaignMatches !== false) {
      return channelFromCheck(candidate, check);
    }
  }
  return undefined;
}

function channelFromCheck(candidate: ChannelCandidate, check: { live: boolean; candidate: ChannelCandidate }): ChannelCandidate {
  return {
    ...candidate,
    live: check.live,
    displayName: check.candidate.displayName ?? candidate.displayName,
    categoryId: check.candidate.categoryId ?? candidate.categoryId,
    categoryName: check.candidate.categoryName ?? candidate.categoryName,
    viewerCount: check.candidate.viewerCount ?? candidate.viewerCount,
    title: check.candidate.title ?? candidate.title,
    profileImageUrl: check.candidate.profileImageUrl ?? candidate.profileImageUrl,
  };
}

function fallbackChannel(platform: Platform, username: string): ChannelCandidate {
  const host = platform === "twitch" ? "https://www.twitch.tv" : "https://kick.com";
  return {
    platform,
    username,
    displayName: username,
    url: `${host}/${username}`,
  };
}

function sessionForDecision(
  decision: WatchDecision,
  previous: WatchSession,
  keepStatus?: { keep: boolean; playbackChecks: number },
): WatchSession {
  if (decision.action === "idle") {
    return {
      ...previous,
      status: "idle",
      channel: undefined,
      campaignId: undefined,
      rewardId: undefined,
      tabId: undefined,
      tabManagedByExtension: undefined,
      message: decision.reason,
      reasonCode: decision.reasonCode,
      playback: undefined,
      playbackChecks: 0,
      watchMode: undefined,
      tablessFallback: undefined,
      heartbeatChecks: 0,
      lastHeartbeatAt: undefined,
      lastHeartbeatOk: undefined,
    };
  }

  const sameChannel = previous.channel?.url === decision.channel?.url && previous.status === "watching";
  const keepPlayback = sameChannel && keepStatus?.keep === true;
  return {
    ...previous,
    status: "watching",
    channel: decision.channel,
    campaignId: decision.campaign?.id,
    rewardId: decision.reward?.id,
    startedAt: keepPlayback ? previous.startedAt : new Date().toISOString(),
    message: decision.reason,
    reasonCode: decision.reasonCode,
    playback: keepPlayback ? previous.playback : undefined,
    playbackChecks: keepStatus?.playbackChecks ?? 0,
  };
}

export interface SchedulerTickResult {
  state: SchedulerState;
  decisions: WatchDecision[];
  events: EngineEvent[];
}

// Closing managed page-context tabs is browser-bound, so it is injected. The
// default forgets them from state only (no tab API) — enough for headless and
// test runs; the extension injects the browser-backed variant that also removes
// the real tabs.
export type StopPageContextTabs = (
  contexts: SchedulerManagedPageContexts,
  options?: { platforms?: Platform[]; reason?: PageContextCloseReason; emit?: EventEmitter },
) => Promise<SchedulerManagedPageContexts> | SchedulerManagedPageContexts;

export interface SchedulerTickOptions {
  platforms?: Platform[];
  stopPageContextTabs?: StopPageContextTabs;
  waitingClaimRewardIds?: Partial<Record<Platform, Set<string>>>;
  emit?: EventEmitter;
}

export async function runSchedulerTick(
  state: SchedulerState,
  settings: EngineSettings,
  adapters: Record<Platform, PlatformAdapter>,
  options: SchedulerTickOptions = {},
): Promise<SchedulerTickResult> {
  const stopPageContextTabs = options.stopPageContextTabs ?? forgetManagedPageContextTabs;
  registerManagedPageContextTabs(state.managedPageContextTabs ?? {});
  let nextState: SchedulerState = {
    ...state,
    campaigns: { ...state.campaigns },
    sessions: { ...state.sessions },
    managedWatchTabs: { ...state.managedWatchTabs },
    managedPageContextTabs: { ...state.managedPageContextTabs },
    deadlineInfeasibleRewardIds: { ...state.deadlineInfeasibleRewardIds },
    lastTickAt: new Date().toISOString(),
  };
  const decisions: WatchDecision[] = [];
  const events: EngineEvent[] = [];
  const emit: EventEmitter = (event) => {
    events.push(event);
    options.emit?.(event);
  };

  async function suspendPlatformForAuthentication(
    platform: Platform,
    previous: WatchSession,
    adapter: PlatformAdapter,
  ): Promise<void> {
    try {
      await adapter.stopWatchTab?.(previous);
    } catch (error) {
      emitDiagnostic(emit, platform, "warn", error instanceof Error ? error.message : "Could not stop watch tab");
    }
    nextState.sessions[platform] = {
      ...previous,
      status: "paused",
      channel: undefined,
      campaignId: undefined,
      rewardId: undefined,
      tabId: undefined,
      tabManagedByExtension: undefined,
      playback: undefined,
      playbackChecks: 0,
      retryAfter: undefined,
      message: "Authentication unavailable",
      reasonCode: "authentication_unhealthy",
      watchMode: undefined,
      tablessFallback: undefined,
      heartbeatChecks: 0,
      lastHeartbeatAt: undefined,
      lastHeartbeatOk: undefined,
    };
    nextState.campaigns[platform] = [];
    nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
    try {
      nextState.managedPageContextTabs = await stopPageContextTabs(nextState.managedPageContextTabs ?? {}, {
        platforms: [platform],
        reason: "authentication_unhealthy",
        emit,
      });
    } catch (error) {
      emitDiagnostic(emit, platform, "warn", error instanceof Error ? error.message : "Could not stop page context");
      nextState.managedPageContextTabs = forgetManagedPageContextTabs(nextState.managedPageContextTabs ?? {}, {
        platforms: [platform],
        reason: "authentication_unhealthy",
        emit,
      });
    }
  }

  const platforms = options.platforms ?? PLATFORMS;
  for (const platform of platforms) {
    const previous = nextState.sessions[platform];
    const platformSettings = settings.platform[platform];
    const adapter = adapters[platform];
    // Seeded neutral so every exit — including the paths that never reach the
    // farming work — still applies a truthful observation. That matters because
    // observeCriticalHealth is what prunes the tab-churn window and releases the
    // managed-tab breaker: a platform that only ever takes an early exit (signed
    // out, disabled) must still be able to recover from an open breaker.
    // Overwritten below as the tick learns what actually happened.
    let observation: CriticalHealthObservation = neutralObservation();
    // Runs in the `finally` below, so every exit — early `continue`, thrown
    // error, or normal completion — reaches the detector exactly once.
    const applyObservation = (): void => {
      if (!settings.criticalFailurePromptEnabled) return;
      const transition = observeCriticalHealth(nextState, platform, observation);
      nextState = transition.state;
      // This runs inside a `finally`, so a throwing listener here would replace
      // the in-flight error and abort the remaining platforms. Health reporting
      // is never worth that.
      if (transition.event) {
        try {
          emit(transition.event);
        } catch {
          // Ignored on purpose: see above.
        }
      }
    };

    try {
      if (settings.pauseOnManualWatch && hasRecentManualWatch(nextState, platform)) {
        await adapter.stopWatchTab?.(previous);
        nextState.sessions[platform] = {
          ...previous,
          status: "paused",
          channel: undefined,
          campaignId: undefined,
          rewardId: undefined,
          tabId: undefined,
          tabManagedByExtension: undefined,
          playback: undefined,
          playbackChecks: 0,
          errorChecks: 0,
          retryAfter: undefined,
          message: "Manual watch detected",
          reasonCode: "manual_watch",
          watchMode: undefined,
          tablessFallback: undefined,
          heartbeatChecks: 0,
          lastHeartbeatAt: undefined,
          lastHeartbeatOk: undefined,
        };
        nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
        nextState.managedPageContextTabs = await stopPageContextTabs(nextState.managedPageContextTabs ?? {}, { platforms: [platform], reason: "manual_watch", emit });
        observation = preconditionBreakObservation();
        emitDiagnostic(emit, platform, "info", "Manual watch detected; pausing farming for this platform");
        continue;
      }
      if (!settings.running || !platformSettings.enabled) {
        await adapter.stopWatchTab?.(previous);
        nextState.sessions[platform] = {
          ...previous,
          status: "paused",
          channel: undefined,
          campaignId: undefined,
          rewardId: undefined,
          tabId: undefined,
          tabManagedByExtension: undefined,
          playback: undefined,
          playbackChecks: 0,
          errorChecks: 0,
          retryAfter: undefined,
          message: "Automation disabled",
          reasonCode: settings.running ? "platform_disabled" : "automation_disabled",
          watchMode: undefined,
          tablessFallback: undefined,
          heartbeatChecks: 0,
          lastHeartbeatAt: undefined,
          lastHeartbeatOk: undefined,
        };
        nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
        nextState.managedPageContextTabs = await stopPageContextTabs(nextState.managedPageContextTabs ?? {}, {
          platforms: [platform],
          reason: settings.running ? "platform_disabled" : "automation_disabled",
          emit,
        });
        emitDiagnostic(emit, platform, "info", "Automation disabled");
        continue;
      }

      if (nextState.authHealth[platform].status !== "healthy") {
        await suspendPlatformForAuthentication(platform, previous, adapter);
        continue;
      }

      // Account-level, so it runs whether or not this platform ends up watching:
      // the watch-time threshold is usually met by a session that has already
      // stopped. Failures are swallowed — gamification is strictly additive to
      // farming and must never fail the tick or trip the error backoff.
      if (autoClaimChallengesFor(settings, platform) && adapter.claimChallenges && challengePollDue(nextState, platform, Date.now())) {
        // Stamped on attempt, not on success, so a persistently failing endpoint
        // is retried on the next interval instead of on every tick.
        nextState.gamification = {
          ...nextState.gamification,
          [platform]: { lastCheckedAt: new Date().toISOString() },
        };
        try {
          for (const challenge of await adapter.claimChallenges()) {
            emit({
              category: "activity",
              code: "challenge_claimed",
              level: "info",
              platform,
              data: { challengeId: challenge.id, rarity: challenge.rarity, recurrence: challenge.recurrence },
            });
          }
        } catch (error) {
          if (authHealthFromError(error)) throw error;
          emitDiagnostic(emit, platform, "warn", error instanceof Error ? error.message : "Challenge claim failed");
        }
      }

      if (isInBackoff(previous)) {
        nextState.sessions[platform] = {
          ...previous,
          status: "error",
          lastCheckedAt: new Date().toISOString(),
          message: `Waiting until ${previous.retryAfter} before retrying after platform errors`,
          reasonCode: "platform_backoff",
        };
        observation = {
          at: Date.now(),
          failing: true,
          progressed: false,
          preconditionBroke: false,
          record: { kind: "api_error", code: "platform_backoff" },
        };
        emitDiagnostic(emit, platform, "warn", nextState.sessions[platform].message ?? "Platform retry deferred");
        continue;
      }

      let campaigns: DropCampaign[];
      let discoveryFailed = false;
      try {
        const discovered = await adapter.discoverCampaigns();
        campaigns = await adapter.readProgress(discovered, previous);
      } catch (error) {
        if (authHealthFromError(error)) throw error;
        if (!hasIdleWatchlistChannels(settings, platform)) throw error;
        // Nothing is farmable this tick, so the decision logic below runs
        // against an empty list and the Idle Watchlist channel wins. State
        // keeps the campaigns from the last good discovery — same retention the
        // rethrow path gets for free — so a transient outage does not blank the
        // popup until the next successful tick.
        campaigns = [];
        discoveryFailed = true;
        observation = apiErrorObservation(error);
        const message = error instanceof Error ? error.message : "Drop discovery failed";
        emitDiagnostic(emit, platform, "warn", `${message}; checking Idle Watchlist fallback`);
        emitDiagnostic(emit, platform, "debug", `Drop discovery error (Idle Watchlist fallback): ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
      if (!discoveryFailed) {
        nextState.campaigns[platform] = campaigns;
        // The accrual arm: fresh progress data is in hand, so compare the active
        // reward's watched minutes against what the last observation recorded.
        const activeWatchReward = activeRewardFor(campaigns, nextState.sessions[platform]);
        const previousWatchedMinutes = nextState.criticalHealth?.[platform]?.lastWatchedMinutes;
        const watchedMinutes = activeWatchReward?.watchedMinutes;
        observation = {
          at: Date.now(),
          failing: false,
          progressed: watchedMinutes !== undefined
            && previousWatchedMinutes !== undefined
            && watchedMinutes > previousWatchedMinutes,
          preconditionBroke: false,
          watchedMinutes,
        };
        if (campaignDiagnosticFingerprint(campaigns) !== campaignDiagnosticFingerprint(state.campaigns[platform])) {
          emitDiagnostic(emit, platform, "debug", `Campaign inventory changed (${campaigns.length} discovered)`);
          const eligibleCount = campaigns.filter((campaign) => isEligible(campaign, settings)).length;
          emitDiagnostic(emit, platform, "debug", `${eligibleCount} of ${campaigns.length} campaigns eligible after filtering`);
        }
      }

      const previousInfeasibleRewardIds = new Set(state.deadlineInfeasibleRewardIds?.[platform]);
      const currentInfeasibleRewardIds: string[] = [];
      for (const campaign of campaigns) {
        for (const reward of campaign.rewards) {
          const feasibility = rewardFeasibility(
            campaign,
            reward,
            settings.skipUnfinishableRewards,
            settings.deadlineSafetyMarginMinutes,
          );
          if (feasibility.kind !== "insufficient_time") continue;
          const diagnosticId = `${campaign.id}:${reward.id}`;
          currentInfeasibleRewardIds.push(diagnosticId);
          if (previousInfeasibleRewardIds.has(diagnosticId)) continue;
          const availableMinutes = feasibility.availableMilliseconds / 60_000;
          emit({
            category: "diagnostic",
            platform,
            level: "info",
            code: "reward_insufficient_time",
            message: `${campaign.name} / ${reward.name} has insufficient time: ${feasibility.remainingMinutes} watch minutes remain, ${availableMinutes.toFixed(2)} minutes are available before ${feasibility.deadline}, margin ${feasibility.marginMinutes} minutes`,
            data: {
              campaignId: campaign.id,
              rewardId: reward.id,
              remainingMinutes: feasibility.remainingMinutes,
              availableMinutes,
              deadline: feasibility.deadline,
              marginMinutes: feasibility.marginMinutes,
            },
          });
        }
      }
      nextState.deadlineInfeasibleRewardIds = {
        ...nextState.deadlineInfeasibleRewardIds,
        [platform]: currentInfeasibleRewardIds,
      };

      if (settings.autoClaim) {
        const claimResult = await claimReadyRewards(
          adapter,
          campaigns,
          options.waitingClaimRewardIds?.[platform] ?? new Set<string>(),
        );
        campaigns = claimResult.campaigns;
        if (!discoveryFailed) {
          nextState.campaigns[platform] = campaigns;
        }
        for (const event of claimResult.events) {
          if (event.claimed) {
            emit({
              category: "activity",
              platform,
              level: "info",
              code: "reward_claimed",
              data: {
                campaignId: event.campaignId,
                campaignName: event.campaignName,
                rewardId: event.rewardId,
                rewardName: event.rewardName,
                method: "automatic",
              },
            });
          } else {
            emitDiagnostic(emit, platform, event.level, event.message);
          }
        }
      }

      let decision = await chooseCampaignDecision(platform, campaigns, settings, adapter);
      const shouldKeep = await shouldKeepWatching(previous, decision, campaigns, settings, adapter);
      // The single site where a stop reason is decided for an existing watch, so
      // the precondition-break arm is set here rather than at every consumer.
      if (!shouldKeep.keep && previous.status === "watching" && ACCRUAL_PRECONDITION_BREAK_REASONS.has(shouldKeep.reasonCode)) {
        observation = preconditionBreakObservation();
      }
      if (!shouldKeep.keep && previous.status === "watching") {
        emitDiagnostic(
          emit,
          platform,
          "debug",
          `Switching watch target (${shouldKeep.reason}); ${previous.watchMode === "tabless" ? "heartbeat" : "playback"} ${isSessionHealthy(previous) ? "healthy" : "unhealthy"}`,
        );
      }
      if (shouldKeep.keep && previous.channel) {
        decision = {
          platform,
          action: previous.campaignId ? "watch" : "fallback",
          campaign: campaigns.find((campaign) => campaign.id === previous.campaignId),
          reward: campaigns
            .find((campaign) => campaign.id === previous.campaignId)
            ?.rewards.find((reward) => reward.id === previous.rewardId),
          channel: shouldKeep.channel ?? previous.channel,
          reason: shouldKeep.reason,
          reasonCode: shouldKeep.reasonCode,
        };
      } else if (previous.status === "watching" && previous.channel && shouldKeep.reason !== "No existing watch session") {
        decision = {
          ...decision,
          reason: shouldKeep.reason,
          reasonCode: shouldKeep.reasonCode,
        };
      }

      const decisionChanged = previous.campaignId !== decision.campaign?.id
        || previous.rewardId !== decision.reward?.id
        || previous.channel?.url !== decision.channel?.url
        || actionForSession(previous) !== decision.action
        || normalizedPreviousReasonCode(previous, decision) !== decision.reasonCode;

      decisions.push(decision);
      if (decisionChanged) {
        const decisionLevel = decision.action === "idle" || ["channel_offline", "watch_unhealthy", "platform_error"].includes(decision.reasonCode)
          ? "warn"
          : "debug";
        emitDiagnostic(
          emit,
          platform,
          decisionLevel,
          `Campaign decision: ${decision.action}${decision.channel ? ` → ${decision.channel.displayName ?? decision.channel.username}` : ""} (${decision.reason})`,
        );
        emitDiagnostic(emit, platform, decisionLevel, decision.reason);
      }
      if (decision.action === "idle") {
        await adapter.stopWatchTab?.(previous);
        nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
      }
      const session = sessionForDecision(decision, previous, shouldKeep);
      if (decision.channel && decision.action !== "idle") {
        const sameChannel = previous.channel?.url === decision.channel.url;
        const useTabless = chooseTablessWatch(previous, settings, adapter, sameChannel);
        session.offlineChecks = shouldKeep.keep ? shouldKeep.offlineChecks : 0;
        session.playbackChecks = useTabless ? 0 : shouldKeep.playbackChecks;

        if (useTabless) {
          // Tabless: no video tab. Close any tab we previously opened for this
          // platform; the controller starts/keeps the heartbeat watcher.
          await adapter.stopWatchTab?.(previous);
          nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
          session.watchMode = "tabless";
          session.tablessFallback = false;
          session.tabId = undefined;
          session.tabManagedByExtension = undefined;
          // Carry heartbeat health across the same channel; reset on a switch.
          session.heartbeatChecks = sameChannel ? previous.heartbeatChecks ?? 0 : 0;
          session.lastHeartbeatAt = sameChannel ? previous.lastHeartbeatAt : undefined;
          session.lastHeartbeatOk = sameChannel ? previous.lastHeartbeatOk : undefined;
          if (!sameChannel || previous.watchMode !== "tabless") {
            emitDiagnostic(emit, platform, "debug", `Tabless watch armed for ${decision.channel.displayName ?? decision.channel.username}`);
          }
        } else {
          // Tab policy (mute / keep-unmuted / auto-close) is owned by the host's
          // injected WatchTabPort, not the engine; the scheduler only forwards the
          // managed-tab handle it tracks in state.
          const watchTabOptions = nextState.managedWatchTabs?.[platform]
            ? { managedTab: nextState.managedWatchTabs[platform] }
            : {};
          const prepared = await adapter.prepareWatchTab(decision.channel, previous, watchTabOptions);
          session.tabId = prepared.tabId;
          session.tabManagedByExtension = prepared.managedByExtension;
          // Mark a deliberate fallback so the next tick stays on the tab for this
          // channel instead of flipping back to a failing tabless heartbeat.
          session.watchMode = "tab";
          session.tablessFallback = Boolean(settings.tablessMode && adapter.supportsTabless);
          if (!sameChannel || previous.watchMode !== "tab" || previous.tabId !== prepared.tabId) {
            emitDiagnostic(emit, platform, "debug", `Watch tab ready (tab ${prepared.tabId}, ${prepared.managedByExtension ? "extension-managed" : "user tab"}) for ${decision.channel.displayName ?? decision.channel.username}`);
          }
          if (prepared.managedByExtension) {
            nextState.managedWatchTabs = {
              ...nextState.managedWatchTabs,
              [platform]: prepared.managedTab ?? {
                platform,
                tabId: prepared.tabId,
                channelUrl: decision.channel.url,
                ownedByExtension: true as const,
              },
            };
          } else {
            nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
          }
        }
        if (autoClaimChannelPointsFor(settings, platform) && adapter.claimChannelPoints) {
          try {
            const claimed = await adapter.claimChannelPoints(decision.channel);
            if (claimed) {
              emitDiagnostic(emit, platform, "info", `Claimed channel points for ${decision.channel.displayName ?? decision.channel.username}`);
            }
          } catch (error) {
            if (authHealthFromError(error)) throw error;
            emitDiagnostic(
              emit,
              platform,
              "warn",
              error instanceof Error ? error.message : "Channel points claim failed",
            );
          }
        }
      }
      session.lastCheckedAt = new Date().toISOString();
      session.errorChecks = 0;
      session.retryAfter = undefined;
      nextState.sessions[platform] = session;
      nextState.managedPageContextTabs = currentManagedPageContextTabs();
    } catch (error) {
      const authHealth = authHealthFromError(error);
      if (authHealth) {
        const transition = applyPlatformAuthHealth(nextState, platform, authHealth);
        nextState = transition.state;
        if (transition.event) emit(transition.event);
        await suspendPlatformForAuthentication(platform, previous, adapter);
        continue;
      }
      // The tick died somewhere in the farming work. Without this the accrual
      // observation set earlier (failing: false) would be what `finally` applies,
      // so a platform failing every tick after a successful discovery would reset
      // its own evidence forever and could never flag.
      observation = apiErrorObservation(error);
      const message = error instanceof Error ? error.message : "Platform scheduler failed";
      const errorChecks = (previous.errorChecks ?? 0) + 1;
      nextState.sessions[platform] = {
        ...previous,
        status: "error",
        lastCheckedAt: new Date().toISOString(),
        errorChecks,
        retryAfter: nextRetryAfter(errorChecks),
        message,
        reasonCode: "platform_error",
      };
      nextState.managedPageContextTabs = currentManagedPageContextTabs();
      emitDiagnostic(emit, platform, "error", `${message}; retry after ${nextState.sessions[platform].retryAfter}`);
      emitDiagnostic(emit, platform, "debug", `Tick failed from status "${previous.status}" (error #${errorChecks}); ${error instanceof Error && error.stack ? error.stack : message}`);
    } finally {
      applyObservation();
    }
  }

  nextState.managedPageContextTabs = currentManagedPageContextTabs();
  return { state: nextState, decisions, events };
}

function hasRecentManualWatch(state: SchedulerState, platform: Platform): boolean {
  const manualWatch = state.manualWatch?.[platform];
  if (!manualWatch?.active) return false;
  const checkedAt = Date.parse(manualWatch.checkedAt);
  return !Number.isNaN(checkedAt) && Date.now() - checkedAt <= MANUAL_WATCH_TTL_MS;
}

function hasIdleWatchlistChannels(settings: EngineSettings, platform: Platform): boolean {
  return settings.platform[platform].idleWatchlistChannels.some((username) => username.trim());
}

function withoutManagedWatchTab(
  managedWatchTabs: SchedulerState["managedWatchTabs"],
  platform: Platform,
): SchedulerState["managedWatchTabs"] {
  const next = { ...managedWatchTabs };
  delete next[platform];
  return next;
}

function isInBackoff(session: WatchSession): boolean {
  if (session.status !== "error" || !session.retryAfter) return false;
  const retryAt = Date.parse(session.retryAfter);
  return !Number.isNaN(retryAt) && Date.now() < retryAt;
}

function nextRetryAfter(errorChecks: number): string {
  const minutes = Math.min(MAX_PLATFORM_BACKOFF_MINUTES, 2 ** Math.max(0, errorChecks - 1));
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

type ClaimReadyRewardEvent = {
  level: "info";
  message: string;
  claimed: true;
  campaignId: string;
  campaignName: string;
  rewardId: string;
  rewardName: string;
} | {
  level: "info" | "warn" | "error";
  message: string;
  claimed?: false;
};

async function claimReadyRewards(
  adapter: PlatformAdapter,
  campaigns: DropCampaign[],
  previouslyWaitingRewardIds: Set<string>,
): Promise<{ campaigns: DropCampaign[]; events: ClaimReadyRewardEvent[] }> {
  const events: ClaimReadyRewardEvent[] = [];
  const updated: DropCampaign[] = [];
  const stillWaitingRewardIds = new Set<string>();

  for (const campaign of campaigns) {
    const rewards: DropReward[] = [];
    for (const reward of campaign.rewards) {
      if (reward.status === "claimable" && canClaimReward(reward)) {
        if (adapter.isClaimReady && !adapter.isClaimReady(reward)) {
          // Watched to completion, but the platform hasn't released the claim
          // yet (e.g. Twitch hasn't returned the drop-instance id). Defer; the
          // next tick re-checks once progress data catches up.
          rewards.push(reward);
          stillWaitingRewardIds.add(reward.id);
          if (!previouslyWaitingRewardIds.has(reward.id)) {
            events.push({
              level: "info",
              message: `${reward.name} watched-complete; waiting for ${campaign.name} claim to be released`,
            });
          }
          continue;
        }
        try {
          const claimed = await adapter.claimReward(campaign, reward);
          rewards.push(claimed ? { ...reward, status: "claimed", watchedMinutes: reward.requiredMinutes } : reward);
          if (claimed) {
            events.push({
              level: "info",
              message: `Claimed ${reward.name} from ${campaign.name}`,
              claimed: true,
              campaignId: campaign.id,
              campaignName: campaign.name,
              rewardId: reward.id,
              rewardName: reward.name,
            });
          } else {
            events.push({
              level: "warn",
              message: `Could not claim ${reward.name} from ${campaign.name}`,
            });
          }
        } catch (error) {
          rewards.push(reward);
          events.push({
            level: "error",
            message: error instanceof Error ? error.message : `Claim failed for ${reward.name}`,
          });
        }
      } else {
        rewards.push(reward);
      }
    }
    updated.push(reconcileCampaignAfterClaims(campaign, rewards));
  }

  previouslyWaitingRewardIds.clear();
  for (const rewardId of stillWaitingRewardIds) previouslyWaitingRewardIds.add(rewardId);

  return { campaigns: updated, events };
}

function isRewardRelevantNow(reward: DropReward): boolean {
  return canClaimReward(reward) || isRewardAvailableToEarn(reward);
}

function isRewardDeadlineFeasible(campaign: DropCampaign, reward: DropReward, settings: EngineSettings): boolean {
  return rewardFeasibility(
    campaign,
    reward,
    settings.skipUnfinishableRewards,
    settings.deadlineSafetyMarginMinutes,
  ).kind !== "insufficient_time";
}

function campaignDiagnosticFingerprint(campaigns: readonly DropCampaign[]): string {
  return campaigns.map((campaign) => `${campaign.id}:${campaign.status}:${campaign.rewards.map((reward) => `${reward.id}:${reward.status}`).join(",")}`).join("|");
}

function isRewardAvailableToEarn(reward: DropReward): boolean {
  if (!isWatchReward(reward)) return false;
  const now = Date.now();
  const startsAt = reward.availableFrom ? Date.parse(reward.availableFrom) : undefined;
  const endsAt = reward.availableUntil ? Date.parse(reward.availableUntil) : undefined;
  if (startsAt != null && !Number.isNaN(startsAt) && now < startsAt) return false;
  if (endsAt != null && !Number.isNaN(endsAt) && now >= endsAt) return false;
  return reward.status !== "claimed" && reward.status !== "claimable";
}

function canClaimReward(reward: DropReward): boolean {
  if (reward.status !== "claimable") return false;
  if (!reward.claimUntil) return true;
  const claimUntil = Date.parse(reward.claimUntil);
  return Number.isNaN(claimUntil) || Date.now() < claimUntil;
}

async function shouldKeepWatching(
  previous: WatchSession,
  nextDecision: WatchDecision,
  campaigns: readonly DropCampaign[],
  settings: EngineSettings,
  adapter: Pick<PlatformAdapter, "checkChannel">,
): Promise<{ keep: boolean; offlineChecks: number; playbackChecks: number; reason: string; reasonCode: WatchReasonCode; channel?: ChannelCandidate }> {
  if (!previous.channel || previous.status !== "watching") {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "No existing watch session", reasonCode: "no_existing_session" };
  }
  const previousReward = campaigns
    .find((campaign) => campaign.id === previous.campaignId)
    ?.rewards.find((reward) => reward.id === previous.rewardId);
  if (previousReward?.status === "claimable" || previousReward?.status === "claimed") {
    return {
      keep: false,
      offlineChecks: 0,
      playbackChecks: 0,
      reason: "Current reward completed; switching farming target",
      reasonCode: "watch_requirement_completed",
    };
  }
  if (nextDecision.action === "idle") {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: nextDecision.reason, reasonCode: nextDecision.reasonCode };
  }
  if (previous.campaignId && nextDecision.action !== "watch") {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "Current campaign is no longer eligible", reasonCode: "campaign_ineligible" };
  }
  if (previous.campaignId && settings.platform[previous.platform].excludedChannels?.includes(previous.channel.username.toLowerCase())) {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "Current channel is excluded from drops", reasonCode: "channel_excluded" };
  }
  if (previous.rewardId && nextDecision.reward?.id !== previous.rewardId) {
    const replacement = classifyRewardSwitch(nextDecision);
    return { keep: false, offlineChecks: 0, playbackChecks: 0, ...replacement };
  }
  // Tabless sessions have no playback telemetry; their health is the heartbeat,
  // which the controller tracks and falls back to a tab on. Here we only keep or
  // switch the channel based on liveness/category, so skip playback retries.
  const isTabless = previous.watchMode === "tabless";
  if (!settings.idleWatchlistFallbackOnly && !previous.campaignId && nextDecision.action === "watch") {
    const fallbackCheck = await adapter.checkChannel(previous.channel);
    const fallbackOfflineChecks = fallbackCheck.live ? 0 : previous.offlineChecks + 1;
    if (fallbackCheck.live && fallbackCheck.categoryMatches) {
      const fallbackPlaybackChecks = isTabless || isPlaybackHealthy(previous) ? 0 : (previous.playbackChecks ?? 0) + 1;
      if (fallbackPlaybackChecks < settings.offlineRetryLimit) {
        return {
          keep: true,
          offlineChecks: fallbackOfflineChecks,
          playbackChecks: fallbackPlaybackChecks,
          channel: channelFromCheck(previous.channel, fallbackCheck),
          reason: "Keeping current Idle Watchlist tab",
          reasonCode: "keeping_idle_watchlist",
        };
      }
    }
  }

  const changedTarget = nextDecision.channel?.url !== previous.channel.url;
  const differentCampaignAvailable = changedTarget
    && nextDecision.action === "watch"
    && nextDecision.campaign?.id !== previous.campaignId;
  if (differentCampaignAvailable) {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "Higher priority eligible campaign available", reasonCode: "higher_priority_reward" };
  }

  // When watching an Idle Watchlist fallback, a different selection means a
  // higher-priority idle watchlist channel is now live (e.g. after reordering the
  // watchlist or one coming online), so switch to it instead of staying put.
  const differentFallbackAvailable = changedTarget
    && nextDecision.action === "fallback"
    && !previous.campaignId;
  if (differentFallbackAvailable) {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "Higher priority Idle Watchlist channel available", reasonCode: "higher_priority_idle_watchlist" };
  }

  const check = await adapter.checkChannel(previous.channel);
  const offlineChecks = check.live ? 0 : previous.offlineChecks + 1;
  if (offlineChecks >= settings.offlineRetryLimit) {
    return { keep: false, offlineChecks, playbackChecks: 0, reason: check.reason ?? "Channel offline retry limit reached", reasonCode: "channel_offline" };
  }

  if (!check.categoryMatches) {
    return { keep: false, offlineChecks, playbackChecks: 0, reason: check.reason ?? "Channel category no longer matches", reasonCode: "channel_mismatch" };
  }

  const playbackChecks = isTabless || isPlaybackHealthy(previous) ? 0 : (previous.playbackChecks ?? 0) + 1;
  if (playbackChecks >= settings.offlineRetryLimit) {
    return {
      keep: false,
      offlineChecks,
      playbackChecks,
      reason: "Watch tab playback did not become active",
      reasonCode: "watch_unhealthy",
    };
  }

  return {
    keep: true,
    offlineChecks,
    playbackChecks,
    channel: channelFromCheck(previous.channel, check),
    reason: "Keeping current watch tab",
    reasonCode: "keeping_current_watch",
  };
}

function isPlaybackHealthy(session: WatchSession): boolean {
  const playback = session.playback;
  if (!playback) return false;
  const checkedAt = Date.parse(playback.checkedAt);
  if (!Number.isNaN(checkedAt) && Date.now() - checkedAt > 2 * 60 * 1000) return false;
  // Playing — muted or not — is what indicates farming is working. The browser
  // can block element-level unmuting in a background tab, so the content script
  // may keep the video muted; that is still healthy as long as it plays.
  return playback.videoCount > 0
    && playback.playingVideoCount > 0;
}

// Health of the current watch, regardless of mode: a tabless session is healthy
// when its last heartbeat was accepted recently; a tab session relies on
// playback telemetry.
function isSessionHealthy(session: WatchSession): boolean {
  return session.watchMode === "tabless" ? isHeartbeatHealthy(session) : isPlaybackHealthy(session);
}

function isHeartbeatHealthy(session: WatchSession): boolean {
  if (!session.lastHeartbeatOk || !session.lastHeartbeatAt) return false;
  const at = Date.parse(session.lastHeartbeatAt);
  if (Number.isNaN(at)) return false;
  return Date.now() - at < 3 * 60 * 1000;
}

function classifyRewardSwitch(
  nextDecision: WatchDecision,
): { reason: string; reasonCode: FarmingStopReason } {
  if (nextDecision.action !== "watch") {
    return {
      reason: "Current campaign is no longer eligible",
      reasonCode: "campaign_ineligible",
    };
  }
  return {
    reason: "Higher priority eligible reward available",
    reasonCode: "higher_priority_reward",
  };
}

function actionForSession(session: WatchSession): WatchDecision["action"] {
  if (session.status !== "watching") return "idle";
  return session.campaignId ? "watch" : "fallback";
}

function normalizedPreviousReasonCode(previous: WatchSession, decision: WatchDecision): WatchReasonCode | undefined {
  if (decision.reasonCode === "keeping_current_watch" && previous.reasonCode === "eligible_campaign") {
    return "keeping_current_watch";
  }
  if (decision.reasonCode === "keeping_idle_watchlist" && previous.reasonCode === "idle_watchlist_selected") {
    return "keeping_idle_watchlist";
  }
  return previous.reasonCode;
}

function emitDiagnostic(
  emit: EventEmitter,
  platform: Platform,
  level: LogLevel,
  message: string,
): void {
  emit({ category: "diagnostic", platform, level, message });
}
