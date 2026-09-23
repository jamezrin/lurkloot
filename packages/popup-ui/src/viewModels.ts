import type { CategorySelection, DropCampaign, ExtensionSettings, Platform, WatchSession } from "@lurkloot/shared/models";
import { NO_CATEGORY_ID, categoryListIndex, favouriteCategoryIndex, isCampaignCategoryBlocked, isUncategorizedCampaign } from "@lurkloot/shared/categories";
import {
  campaignHasSubscriptionRewards,
  campaignHasWatchRewards,
  isWatchReward,
  rewardRequirementType,
  rewardFeasibility,
} from "@lurkloot/shared/rewards";
import { isCampaignExpired, isCampaignFinished } from "@lurkloot/shared/campaignFilters";
import { evaluateCampaignFarming } from "@lurkloot/shared/campaignFarming";
export {
  campaignFilterCategories,
  campaignSection,
  isCampaignExpired,
  isCampaignFinished,
  isCampaignUpcoming,
  type CampaignSection,
} from "@lurkloot/shared/campaignFilters";
import { CAMPAIGN_TINTS, GAME_ACCENTS, NO_CATEGORY_ACCENT, REWARD_TINTS } from "./constants";
import { initials } from "./format";
import type { CampaignLifecycleState, CampaignStats, CampaignView, ChannelLink, FarmingChannelView, GameItem, RewardView, StreamerItem, TFunction } from "./types";

const KICK_ASSET_BASE = "https://ext.kick.com";

function kickRewardImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  return `${KICK_ASSET_BASE}/${value.replace(/^\/+/, "")}`;
}

// The popup renders exactly what the scheduler ranks: same function, same
// settings, so the rank on a card is the position the engine acts on.
export { rankCampaigns, campaignRankTier, pinCampaignAt, unpinCampaign, type CampaignRankTier } from "@lurkloot/shared/ranking";
import { campaignRankTier } from "@lurkloot/shared/ranking";
import { campaignSection } from "@lurkloot/shared/campaignFilters";

export function gameItemsFromCampaigns(campaigns: DropCampaign[], t: TFunction): GameItem[] {
  const discovered = new Map<string, GameItem>();
  campaigns.forEach((campaign, index) => {
    const id = gameId(campaign);
    const existing = discovered.get(id);
    if (existing) {
      if (id !== NO_CATEGORY_ID && !existing.imageUrl && campaign.gameImageUrl) {
        discovered.set(id, { ...existing, imageUrl: campaign.gameImageUrl });
      }
      return;
    }
    discovered.set(id, id === NO_CATEGORY_ID
      ? { id, name: t("noCategory"), short: "–", accent: NO_CATEGORY_ACCENT }
      : {
        id,
        name: campaign.gameName ?? t("unknownGame"),
        short: initials(campaign.gameName ?? campaign.name),
        accent: GAME_ACCENTS[index % GAME_ACCENTS.length],
        imageUrl: campaign.gameImageUrl,
      });
  });
  return [...discovered.values()].sort((left, right) => left.name.localeCompare(right.name));
}

// The campaign's category as the settings lists store it: the platform id with
// the display name beside it, so a game starred or blocked from a campaign row
// renders in Games even once no campaign of it is running. Uncategorized
// campaigns have nothing to star or block.
function campaignCategory(campaign: DropCampaign): CategorySelection | undefined {
  if (isUncategorizedCampaign(campaign)) return undefined;
  const name = campaign.gameName ?? campaign.categoryId ?? campaign.name;
  return { id: campaign.categoryId ?? name, name, ...(campaign.gameImageUrl ? { imageUrl: campaign.gameImageUrl } : {}) };
}

function gameId(campaign: DropCampaign): string {
  if (isUncategorizedCampaign(campaign)) return NO_CATEGORY_ID;
  return (campaign.categoryId ?? campaign.gameName ?? campaign.name).trim().toLowerCase();
}

export function fallbackGame(campaign: DropCampaign | CampaignView, index: number, t: TFunction): GameItem {
  const id = "gameId" in campaign ? campaign.gameId : gameId(campaign);
  const name = "title" in campaign ? t("dropsCampaign") : campaign.gameName ?? t("dropsCampaign");
  const short = "thumbnail" in campaign ? campaign.thumbnail : initials(campaign.gameName ?? campaign.name);
  return { id, name, short, accent: GAME_ACCENTS[Math.max(0, index) % GAME_ACCENTS.length] };
}

export function campaignStats(campaign: CampaignView): CampaignStats {
  const watchRewards = campaign.rewards.filter(isWatchReward);
  const requirementKinds = new Set(campaign.rewards.map(rewardRequirementType));
  const kind = requirementKinds.size > 1
    ? "mixed"
    : requirementKinds.values().next().value ?? "watch";
  const totalRequired = watchRewards.reduce((sum, reward) => sum + reward.requiredMinutes, 0);
  const totalFarmed = watchRewards.reduce((sum, reward) => sum + (reward.requiredMinutes * (reward.progress ?? 0)) / 100, 0);
  const remaining = Math.max(totalRequired - totalFarmed, 0);
  const progress = totalRequired ? Math.min(100, (totalFarmed / totalRequired) * 100) : undefined;
  const completed = campaign.rewards.filter(rewardComplete).length;
  const nextIncompleteReward = campaign.rewards.find((reward) => !rewardComplete(reward));
  const nextReward = nextIncompleteReward ?? campaign.rewards.at(-1);
  const nextRewardRemaining = nextIncompleteReward?.requirement === "watch"
    ? Math.max(nextIncompleteReward.requiredMinutes * (1 - (nextIncompleteReward.progress ?? 0) / 100), 0)
    : undefined;
  const complete = campaign.rewards.length > 0 && campaign.rewards.every((reward) => reward.obtained);
  return { kind, totalRequired, totalFarmed, remaining, progress, completed, totalRewards: campaign.rewards.length, nextReward, nextRewardRemaining, complete };
}

function indexOrUndefined(index: number): number | undefined {
  return index === -1 ? undefined : index;
}

function rewardComplete(reward: RewardView): boolean {
  return reward.obtained || (reward.progress ?? 0) >= 100;
}

export function campaignViewFromCampaign(
  campaign: DropCampaign,
  index: number,
  session: WatchSession,
  excluded: boolean,
  feasibility?: { skipUnfinishableRewards: boolean; deadlineSafetyMarginMinutes: number; now?: number; settings?: ExtensionSettings },
): CampaignView {
  const farmingEvaluation = feasibility?.settings
    ? evaluateCampaignFarming(campaign, feasibility.settings, { includePinnedOnly: true, now: feasibility.now })
    : undefined;
  const settings = feasibility?.settings;
  return {
    id: campaign.id,
    gameId: gameId(campaign),
    title: campaign.name,
    status: campaign.status,
    lifecycle: campaignLifecycleState(campaign),
    pinned: settings ? settings.campaignPins.includes(campaign.id) : false,
    pinIndex: settings ? indexOrUndefined(settings.campaignPins.indexOf(campaign.id)) : undefined,
    category: campaignCategory(campaign),
    favouriteIndex: settings ? indexOrUndefined(favouriteCategoryIndex(campaign, settings.platform[campaign.platform])) : undefined,
    categoryBlocked: settings ? isCampaignCategoryBlocked(campaign, settings.platform[campaign.platform]) : false,
    // Starred, whether or not a block currently stops the star from ranking.
    favourited: settings ? categoryListIndex(campaign, settings.platform[campaign.platform].favouriteCategories) !== -1 : false,
    rankTier: settings ? campaignRankTier(campaign, settings) : "strategy",
    section: settings ? campaignSection(campaign, settings) : "queue",
    linked: campaign.accountLinked !== false,
    linkUrl: campaign.accountLinkUrl || undefined,
    pageUrl: campaign.url || undefined,
    excluded,
    starts: campaign.startsAt ?? campaign.rewards.find((reward) => reward.availableFrom)?.availableFrom ?? "",
    ends: campaign.endsAt ?? campaign.rewards.find((reward) => reward.availableUntil)?.availableUntil ?? "",
    channels: channelLinks(campaign),
    farmingChannel: session.campaignId === campaign.id ? channelViewFromSession(session) : undefined,
    thumbnail: initials(campaign.gameName ?? campaign.name),
    tint: CAMPAIGN_TINTS[index % CAMPAIGN_TINTS.length],
    imageUrl: campaign.gameImageUrl,
    rewards: campaign.rewards.map((reward, rewardIndex) => {
      const requirement = rewardRequirementType(reward);
      const progress = isWatchReward(reward) && reward.requiredMinutes > 0
        ? Math.min(100, (Math.min(reward.watchedMinutes, reward.requiredMinutes) / reward.requiredMinutes) * 100)
        : reward.status === "claimed" ? 100 : undefined;
      const claimGuidance = safeClaimGuidance(reward.claimGuidance ?? campaign.claimGuidance);
      const deadlineFeasibility = feasibility
        ? rewardFeasibility(
            campaign,
            reward,
            feasibility.skipUnfinishableRewards,
            feasibility.deadlineSafetyMarginMinutes,
            feasibility.now,
          )
        : undefined;
      return {
        id: reward.id,
        name: reward.name,
        progress,
        requiredMinutes: reward.requiredMinutes,
        requiredSubs: reward.requiredSubs,
        requirement,
        obtained: reward.status === "claimed",
        art: initials(reward.name).slice(0, 8),
        tint: REWARD_TINTS[rewardIndex % REWARD_TINTS.length],
        imageUrl: campaign.platform === "kick" ? kickRewardImageUrl(reward.imageUrl) : reward.imageUrl,
        claimGuidance,
        ineligibilityReason: deadlineFeasibility?.kind === "insufficient_time" ? "insufficient_time" : undefined,
      };
    }),
    hasWatchRewards: campaignHasWatchRewards(campaign),
    hasSubscriptionRewards: campaignHasSubscriptionRewards(campaign),
    farmingRejection: farmingEvaluation && !farmingEvaluation.farmable ? farmingEvaluation : undefined,
  };
}

function safeClaimGuidance(guidance: DropCampaign["claimGuidance"]): DropCampaign["claimGuidance"] {
  if (guidance?.kind !== "link_required") return undefined;
  try {
    return new URL(guidance.url).protocol === "https:" ? guidance : undefined;
  } catch {
    return undefined;
  }
}

export function campaignLifecycleState(campaign: DropCampaign): CampaignLifecycleState | undefined {
  if (isCampaignFinished(campaign)) return "finished";
  if (isCampaignExpired(campaign)) return "expired";
  if (campaign.status === "upcoming") return "upcoming";
  return undefined;
}

// URL of a channel's page on its platform.
export function channelUrl(platform: Platform, name: string): string {
  const base = platform === "kick" ? "https://kick.com/" : "https://www.twitch.tv/";
  return `${base}${name}`;
}

// Every channel a restricted drop is tied to, each linked to its page. Empty for
// general drops (any channel in the category qualifies).
function channelLinks(campaign: DropCampaign): ChannelLink[] {
  if (campaign.isGeneralDrop || !campaign.allowedChannels?.length) return [];
  return campaign.allowedChannels.map((name) => ({ name, url: channelUrl(campaign.platform, name) }));
}

export function channelViewFromSession(session: WatchSession): FarmingChannelView | undefined {
  if (session.status !== "watching") return undefined;
  const channel = session.channel;
  if (!channel) return undefined;
  return {
    name: channel.displayName ?? channel.username,
    category: channel.categoryName,
    viewers: channel.viewerCount,
    url: channel.url || channelUrl(channel.platform, channel.username),
  };
}

export function streamerItemFromFallback(username: string, session: WatchSession, t: TFunction): StreamerItem {
  const channel = session.channel;
  const live = channel != null && channel.username.toLowerCase() === username.toLowerCase() && session.status === "watching";
  if (!live) return { id: username, name: username, live: false, subtitle: t("idleWatchlistChannel") };
  return {
    id: username,
    name: channel.displayName ?? username,
    live: true,
    subtitle: channel.categoryName,
    viewers: channel.viewerCount,
  };
}
