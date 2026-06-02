import type { PlatformAdapter } from "../platforms/adapter";
import type {
  ChannelCandidate,
  DropCampaign,
  DropReward,
  ExtensionSettings,
  Platform,
  SchedulerState,
  WatchDecision,
  WatchSession,
} from "./models";
import { currentManagedPageContextTabs, registerManagedPageContextTabs, stopManagedPageContextTabs } from "./tabs";
import { appendLog, type LogLevel } from "./logging";

const PLATFORMS: Platform[] = ["twitch", "kick"];
const MAX_PLATFORM_BACKOFF_MINUTES = 30;
export const MANUAL_WATCH_TTL_MS = 20_000;

function activeReward(campaign: DropCampaign): DropReward | undefined {
  const earnable = campaign.rewards.filter((reward) => reward.preconditionsMet !== false && isRewardAvailableToEarn(reward));
  return earnable.find((reward) => reward.status === "in_progress")
    ?? earnable.find((reward) => reward.status === "locked");
}

// Decides whether to farm this channel without a tab. Off unless tabless mode is
// enabled and the platform supports it; falls back to a tab (returns false) when
// we deliberately switched to a tab for this same channel, or when tabless
// heartbeats have been failing past the retry limit.
function chooseTablessWatch(
  previous: WatchSession,
  settings: ExtensionSettings,
  adapter: Pick<PlatformAdapter, "supportsTabless">,
  sameChannel: boolean,
): boolean {
  if (!settings.tablessMode || !adapter.supportsTabless) return false;
  if (sameChannel && previous.watchMode === "tab" && previous.tablessFallback) return false;
  if (sameChannel && previous.watchMode === "tabless" && (previous.heartbeatChecks ?? 0) >= settings.offlineRetryLimit) return false;
  return true;
}

function isEligible(campaign: DropCampaign, settings: ExtensionSettings): boolean {
  if (campaign.status !== "active") return false;
  if (hasCampaignEnded(campaign)) return false;
  if (campaign.eligibility && campaign.eligibility !== "eligible") return false;
  if (settings.excludedCampaignIds.includes(campaign.id)) return false;
  if (campaign.accountLinked === false) return false;
  return campaign.rewards.some((reward) => reward.status !== "claimed" && reward.preconditionsMet !== false && isRewardRelevantNow(reward));
}

function hasCampaignEnded(campaign: DropCampaign): boolean {
  if (!campaign.endsAt) return false;
  const endsAt = Date.parse(campaign.endsAt);
  return !Number.isNaN(endsAt) && endsAt < Date.now();
}

function availabilityScore(campaign: DropCampaign): number {
  if (campaign.allowedChannels?.length) return campaign.allowedChannels.length;
  return Number.MAX_SAFE_INTEGER;
}

function endScore(campaign: DropCampaign): number {
  return campaign.endsAt ? Date.parse(campaign.endsAt) : Number.MAX_SAFE_INTEGER;
}

export function sortCampaigns(campaigns: DropCampaign[], settings: ExtensionSettings): DropCampaign[] {
  return [...campaigns].sort((left, right) => {
    const leftPriority = settings.campaignPriorities[left.id] ?? left.priority;
    const rightPriority = settings.campaignPriorities[right.id] ?? right.priority;
    if (leftPriority != null && rightPriority != null && leftPriority !== rightPriority) return rightPriority - leftPriority;
    if (leftPriority != null && rightPriority == null) return -1;
    if (rightPriority != null && leftPriority == null) return 1;

    const gameOrder = gamePriorityScore(left, settings) - gamePriorityScore(right, settings);
    if (gameOrder !== 0) return gameOrder;

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

function gamePriorityScore(campaign: DropCampaign, settings: ExtensionSettings): number {
  if (!campaign.categoryId && !campaign.gameName) return Number.MAX_SAFE_INTEGER;
  const candidates = [campaign.categoryId, campaign.gameName]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  const priority = settings.platform[campaign.platform].gamePriority ?? [];
  const index = priority.findIndex((value) => candidates.includes(value.toLowerCase()));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export async function chooseCampaignDecision(
  platform: Platform,
  campaigns: DropCampaign[],
  settings: ExtensionSettings,
  adapter: Pick<PlatformAdapter, "listCandidateChannels" | "checkChannel">,
): Promise<WatchDecision> {
  const sorted = sortCampaigns(campaigns.filter((campaign) => isEligible(campaign, settings)), settings);
  const noCampaignReason = noEligibleCampaignReason(campaigns, settings);

  for (const campaign of sorted) {
    const reward = activeReward(campaign);
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
      };
    }
  }

  const fallbackCandidates = settings.platform[platform].watchQueueChannels
    .map((username) => username.trim().toLowerCase())
    .filter(Boolean)
    .map((username) => fallbackChannel(platform, username));
  const fallback = await firstValidCandidate(fallbackCandidates, undefined, adapter);

  if (fallback) {
    return {
      platform,
      action: "fallback",
      channel: fallback,
      reason: `${noCampaignReason}; Watch Queue channel selected`,
    };
  }

  return { platform, action: "idle", reason: `${noCampaignReason} and no Watch Queue channels` };
}

function noEligibleCampaignReason(campaigns: DropCampaign[], settings: ExtensionSettings): string {
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
  if (notExcluded.every((campaign) => campaign.eligibility === "no_rewards" || campaign.rewards.length === 0)) {
    return "Campaigns have no time-based rewards";
  }
  if (notExcluded.every((campaign) => campaign.accountLinked === false || campaign.eligibility === "account_not_linked")) {
    return "Campaign accounts are not linked";
  }
  return "No eligible campaigns";
}

async function firstValidCandidate(
  candidates: ChannelCandidate[],
  campaign: DropCampaign | undefined,
  adapter: Pick<PlatformAdapter, "checkChannel">,
): Promise<ChannelCandidate | undefined> {
  for (const candidate of candidates) {
    const check = await adapter.checkChannel(candidate, campaign);
    if (check.live && check.categoryMatches) {
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
    playback: keepPlayback ? previous.playback : undefined,
    playbackChecks: keepStatus?.playbackChecks ?? 0,
  };
}

export interface SchedulerTickResult {
  state: SchedulerState;
  decisions: WatchDecision[];
}

export interface SchedulerTickOptions {
  platforms?: Platform[];
}

export async function runSchedulerTick(
  state: SchedulerState,
  settings: ExtensionSettings,
  adapters: Record<Platform, PlatformAdapter>,
  options: SchedulerTickOptions = {},
): Promise<SchedulerTickResult> {
  registerManagedPageContextTabs(state.managedPageContextTabs ?? {});
  let nextState: SchedulerState = {
    ...state,
    campaigns: { ...state.campaigns },
    sessions: { ...state.sessions },
    managedWatchTabs: { ...state.managedWatchTabs },
    managedPageContextTabs: { ...state.managedPageContextTabs },
    lastTickAt: new Date().toISOString(),
  };
  const decisions: WatchDecision[] = [];
  const verbose = settings.verboseLogging;

  const platforms = options.platforms ?? PLATFORMS;
  for (const platform of platforms) {
    const previous = nextState.sessions[platform];
    const platformSettings = settings.platform[platform];
    const adapter = adapters[platform];

    try {
      nextState = addTickEvent(nextState, platform, "debug", `Tick start (previous status: ${previous.status})`, verbose);
      if (settings.pauseOnManualWatch && hasRecentManualWatch(nextState, platform)) {
        await adapter.stopWatchTab?.(previous, { closeManagedTabs: settings.autoCloseFinishedDrops });
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
          watchMode: undefined,
          tablessFallback: undefined,
          heartbeatChecks: 0,
          lastHeartbeatAt: undefined,
          lastHeartbeatOk: undefined,
        };
        nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
        nextState.managedPageContextTabs = await stopManagedPageContextTabs(nextState.managedPageContextTabs ?? {}, { platforms: [platform] });
        nextState = addTickEvent(nextState, platform, "info", "Manual watch detected; pausing farming for this platform", verbose);
        continue;
      }
      if (!settings.running || !platformSettings.enabled) {
        await adapter.stopWatchTab?.(previous, { closeManagedTabs: settings.autoCloseFinishedDrops });
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
          watchMode: undefined,
          tablessFallback: undefined,
          heartbeatChecks: 0,
          lastHeartbeatAt: undefined,
          lastHeartbeatOk: undefined,
        };
        nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
        nextState.managedPageContextTabs = await stopManagedPageContextTabs(nextState.managedPageContextTabs ?? {}, { platforms: [platform] });
        nextState = addTickEvent(nextState, platform, "info", "Automation disabled", verbose);
        continue;
      }

      if (isInBackoff(previous)) {
        nextState.sessions[platform] = {
          ...previous,
          status: "error",
          lastCheckedAt: new Date().toISOString(),
          message: `Waiting until ${previous.retryAfter} before retrying after platform errors`,
        };
        nextState = addTickEvent(nextState, platform, "warn", nextState.sessions[platform].message ?? "Platform retry deferred", verbose);
        continue;
      }

      let campaigns: DropCampaign[];
      try {
        const discovered = await adapter.discoverCampaigns();
        campaigns = await adapter.readProgress(discovered, previous);
      } catch (error) {
        if (!hasWatchQueueChannels(settings, platform)) throw error;
        campaigns = [];
        const message = error instanceof Error ? error.message : "Drop discovery failed";
        nextState = addTickEvent(nextState, platform, "warn", `${message}; checking Watch Queue fallback`, verbose);
      }
      nextState.campaigns[platform] = campaigns;
      nextState = addTickEvent(nextState, platform, "info", `Discovered ${campaigns.length} campaigns`, verbose);
      const eligibleCount = campaigns.filter((campaign) => isEligible(campaign, settings)).length;
      nextState = addTickEvent(nextState, platform, "debug", `${eligibleCount} of ${campaigns.length} campaigns eligible after filtering`, verbose);

      if (settings.autoClaim) {
        const claimResult = await claimReadyRewards(adapter, campaigns);
        campaigns = claimResult.campaigns;
        nextState.campaigns[platform] = campaigns;
        for (const event of claimResult.events) {
          nextState = addTickEvent(nextState, platform, event.level, event.message, verbose);
        }
      }

      let decision = await chooseCampaignDecision(platform, campaigns, settings, adapter);
      nextState = addTickEvent(
        nextState,
        platform,
        "debug",
        `Campaign decision: ${decision.action}${decision.channel ? ` → ${decision.channel.displayName ?? decision.channel.username}` : ""} (${decision.reason})`,
        verbose,
      );
      const shouldKeep = await shouldKeepWatching(previous, decision, settings, adapter);
      nextState = addTickEvent(
        nextState,
        platform,
        "debug",
        `Keep-watching check: ${shouldKeep.keep ? "keep" : "switch"} (${shouldKeep.reason}); ${previous.watchMode === "tabless" ? "heartbeat" : "playback"} ${isSessionHealthy(previous) ? "healthy" : "unhealthy"}`,
        verbose,
      );
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
        };
      } else if (previous.status === "watching" && previous.channel && shouldKeep.reason !== "No existing watch session") {
        decision = {
          ...decision,
          reason: shouldKeep.reason,
        };
      }

      decisions.push(decision);
      nextState = addTickEvent(nextState, platform, decision.action === "idle" ? "warn" : "info", decision.reason, verbose);
      if (decision.action === "idle") {
        await adapter.stopWatchTab?.(previous, { closeManagedTabs: settings.autoCloseFinishedDrops });
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
          await adapter.stopWatchTab?.(previous, { closeManagedTabs: settings.autoCloseFinishedDrops });
          nextState.managedWatchTabs = withoutManagedWatchTab(nextState.managedWatchTabs, platform);
          session.watchMode = "tabless";
          session.tablessFallback = false;
          session.tabId = undefined;
          session.tabManagedByExtension = undefined;
          // Carry heartbeat health across the same channel; reset on a switch.
          session.heartbeatChecks = sameChannel ? previous.heartbeatChecks ?? 0 : 0;
          session.lastHeartbeatAt = sameChannel ? previous.lastHeartbeatAt : undefined;
          session.lastHeartbeatOk = sameChannel ? previous.lastHeartbeatOk : undefined;
          nextState = addTickEvent(
            nextState,
            platform,
            "debug",
            `Tabless watch armed for ${decision.channel.displayName ?? decision.channel.username}`,
            verbose,
          );
        } else {
          const watchTabOptions = {
            muted: settings.muteFarmingTabs,
            closeManagedTabs: settings.autoCloseFinishedDrops,
            keepVideosUnmuted: settings.keepFarmingVideosUnmuted,
            ...(nextState.managedWatchTabs?.[platform] ? { managedTab: nextState.managedWatchTabs[platform] } : {}),
          };
          const prepared = await adapter.prepareWatchTab(decision.channel, previous, watchTabOptions);
          session.tabId = prepared.tabId;
          session.tabManagedByExtension = prepared.managedByExtension;
          // Mark a deliberate fallback so the next tick stays on the tab for this
          // channel instead of flipping back to a failing tabless heartbeat.
          session.watchMode = "tab";
          session.tablessFallback = Boolean(settings.tablessMode && adapter.supportsTabless);
          nextState = addTickEvent(
            nextState,
            platform,
            "debug",
            `Watch tab ready (tab ${prepared.tabId}, ${prepared.managedByExtension ? "extension-managed" : "user tab"}) for ${decision.channel.displayName ?? decision.channel.username}`,
            verbose,
          );
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
        nextState.managedPageContextTabs = await stopManagedPageContextTabs(currentManagedPageContextTabs(), { platforms: [platform] });
        if (settings.autoClaimChannelPoints && adapter.claimChannelPoints) {
          try {
            const claimed = await adapter.claimChannelPoints(decision.channel);
            if (claimed) {
              nextState = addTickEvent(nextState, platform, "info", `Claimed channel points for ${decision.channel.displayName ?? decision.channel.username}`, verbose);
            }
          } catch (error) {
            nextState = addTickEvent(
              nextState,
              platform,
              "warn",
              error instanceof Error ? error.message : "Channel points claim failed",
              verbose,
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
      const message = error instanceof Error ? error.message : "Platform scheduler failed";
      const errorChecks = (previous.errorChecks ?? 0) + 1;
      nextState.sessions[platform] = {
        ...previous,
        status: "error",
        lastCheckedAt: new Date().toISOString(),
        errorChecks,
        retryAfter: nextRetryAfter(errorChecks),
        message,
      };
      nextState.managedPageContextTabs = currentManagedPageContextTabs();
      nextState = addTickEvent(nextState, platform, "error", `${message}; retry after ${nextState.sessions[platform].retryAfter}`, verbose);
    }
  }

  nextState.managedPageContextTabs = currentManagedPageContextTabs();
  return { state: nextState, decisions };
}

function hasRecentManualWatch(state: SchedulerState, platform: Platform): boolean {
  const manualWatch = state.manualWatch?.[platform];
  if (!manualWatch?.active) return false;
  const checkedAt = Date.parse(manualWatch.checkedAt);
  return !Number.isNaN(checkedAt) && Date.now() - checkedAt <= MANUAL_WATCH_TTL_MS;
}

function hasWatchQueueChannels(settings: ExtensionSettings, platform: Platform): boolean {
  return settings.platform[platform].watchQueueChannels.some((username) => username.trim());
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

async function claimReadyRewards(
  adapter: PlatformAdapter,
  campaigns: DropCampaign[],
): Promise<{ campaigns: DropCampaign[]; events: Array<{ level: "info" | "warn" | "error"; message: string }> }> {
  const events: Array<{ level: "info" | "warn" | "error"; message: string }> = [];
  const updated: DropCampaign[] = [];

  for (const campaign of campaigns) {
    const rewards: DropReward[] = [];
    for (const reward of campaign.rewards) {
      if (reward.status === "claimable" && canClaimReward(reward)) {
        if (adapter.isClaimReady && !adapter.isClaimReady(reward)) {
          // Watched to completion, but the platform hasn't released the claim
          // yet (e.g. Twitch hasn't returned the drop-instance id). Defer; the
          // next tick re-checks once progress data catches up.
          rewards.push(reward);
          events.push({
            level: "info",
            message: `${reward.name} watched-complete; waiting for ${campaign.name} claim to be released`,
          });
          continue;
        }
        try {
          const claimed = await adapter.claimReward(campaign, reward);
          rewards.push(claimed ? { ...reward, status: "claimed", watchedMinutes: reward.requiredMinutes } : reward);
          events.push({
            level: claimed ? "info" : "warn",
            message: claimed
              ? `Claimed ${reward.name} from ${campaign.name}`
              : `Could not claim ${reward.name} from ${campaign.name}`,
          });
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
    updated.push({
      ...campaign,
      rewards,
      status: rewards.every((reward) => reward.status === "claimed") ? "completed" : campaign.status,
    });
  }

  return { campaigns: updated, events };
}

function isRewardRelevantNow(reward: DropReward): boolean {
  return canClaimReward(reward) || isRewardAvailableToEarn(reward);
}

function isRewardAvailableToEarn(reward: DropReward): boolean {
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
  settings: ExtensionSettings,
  adapter: Pick<PlatformAdapter, "checkChannel">,
): Promise<{ keep: boolean; offlineChecks: number; playbackChecks: number; reason: string; channel?: ChannelCandidate }> {
  if (!previous.channel || previous.status !== "watching") {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "No existing watch session" };
  }
  if (nextDecision.action === "idle") {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: nextDecision.reason };
  }
  if (previous.campaignId && nextDecision.action !== "watch") {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "Current campaign is no longer eligible" };
  }
  if (previous.campaignId && settings.platform[previous.platform].excludedChannels?.includes(previous.channel.username.toLowerCase())) {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "Current channel is excluded from drops" };
  }
  // Tabless sessions have no playback telemetry; their health is the heartbeat,
  // which the controller tracks and falls back to a tab on. Here we only keep or
  // switch the channel based on liveness/category, so skip playback retries.
  const isTabless = previous.watchMode === "tabless";
  if (!settings.watchQueueFallbackOnly && !previous.campaignId && nextDecision.action === "watch") {
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
          reason: "Keeping current Watch Queue tab",
        };
      }
    }
  }

  const changedTarget = nextDecision.channel?.url !== previous.channel.url;
  const differentCampaignAvailable = changedTarget
    && nextDecision.action === "watch"
    && nextDecision.campaign?.id !== previous.campaignId;
  if (differentCampaignAvailable) {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "Higher priority eligible campaign available" };
  }

  // When watching a Watch Queue fallback, a different selection means a
  // higher-priority watch queue channel is now live (e.g. after reordering the
  // queue or one coming online), so switch to it instead of staying put.
  const differentFallbackAvailable = changedTarget
    && nextDecision.action === "fallback"
    && !previous.campaignId;
  if (differentFallbackAvailable) {
    return { keep: false, offlineChecks: 0, playbackChecks: 0, reason: "Higher priority Watch Queue channel available" };
  }

  const check = await adapter.checkChannel(previous.channel);
  const offlineChecks = check.live ? 0 : previous.offlineChecks + 1;
  if (offlineChecks >= settings.offlineRetryLimit) {
    return { keep: false, offlineChecks, playbackChecks: 0, reason: check.reason ?? "Channel offline retry limit reached" };
  }

  if (!check.categoryMatches) {
    return { keep: false, offlineChecks, playbackChecks: 0, reason: check.reason ?? "Channel category no longer matches" };
  }

  const playbackChecks = isTabless || isPlaybackHealthy(previous) ? 0 : (previous.playbackChecks ?? 0) + 1;
  if (playbackChecks >= settings.offlineRetryLimit) {
    return {
      keep: false,
      offlineChecks,
      playbackChecks,
      reason: "Watch tab playback did not become active",
    };
  }

  return {
    keep: true,
    offlineChecks,
    playbackChecks,
    channel: channelFromCheck(previous.channel, check),
    reason: "Keeping current watch tab",
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

// Records a tick event unless it is a debug entry while verbose logging is off —
// debug detail is opt-in so the rolling log stays readable by default.
function addTickEvent(
  state: SchedulerState,
  platform: Platform,
  level: LogLevel,
  message: string,
  verbose: boolean,
): SchedulerState {
  if (level === "debug" && !verbose) return state;
  return appendLog(state, { platform, level, message });
}
