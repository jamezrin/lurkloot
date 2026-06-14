import type { CampaignFilterKey, CategorySelection, DropCampaign, ExtensionSettings, WatchSession } from "@lurkloot/shared/models";
import { CAMPAIGN_TINTS, GAME_ACCENTS, REWARD_TINTS } from "./constants";
import { initials } from "./format";
import type { CampaignLifecycleState, CampaignView, FarmingChannelView, GameItem, StreamerItem, TFunction } from "./types";

const KICK_ASSET_BASE = "https://ext.kick.com";

function kickRewardImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  return `${KICK_ASSET_BASE}/${value.replace(/^\/+/, "")}`;
}

export function isCampaignExpired(campaign: DropCampaign): boolean {
  if (campaign.status === "expired") return true;
  if (campaign.endsAt) {
    const endsAt = Date.parse(campaign.endsAt);
    if (!Number.isNaN(endsAt) && endsAt < Date.now()) return true;
  }
  return false;
}

export function isCampaignFinished(campaign: DropCampaign): boolean {
  if (campaign.status === "completed") return true;
  return campaign.rewards.length > 0 && campaign.rewards.every((reward) => reward.status === "claimed");
}

export function campaignFilterCategories(campaign: DropCampaign, excludedIds: Set<string>): CampaignFilterKey[] {
  const categories: CampaignFilterKey[] = [];
  if (excludedIds.has(campaign.id)) categories.push("excluded");
  if (campaign.accountLinked === false) categories.push("notLinked");
  if (isCampaignFinished(campaign)) categories.push("finished");
  else if (isCampaignExpired(campaign)) categories.push("expired");
  else if (campaign.status === "upcoming") categories.push("upcoming");
  return categories;
}

export function isCampaignVisible(campaign: DropCampaign, settings: ExtensionSettings, excludedIds: Set<string>): boolean {
  if (campaign.rewards.some((reward) => reward.status === "claimable")) return true;
  return campaignFilterCategories(campaign, excludedIds).every((key) => settings.campaignVisibility[key]);
}

export function sortCampaignsForPopup(campaigns: DropCampaign[], settings: ExtensionSettings): DropCampaign[] {
  return [...campaigns].sort((left, right) => {
    const leftPriority = settings.campaignPriorities[left.id] ?? left.priority;
    const rightPriority = settings.campaignPriorities[right.id] ?? right.priority;
    if (leftPriority != null && rightPriority != null && leftPriority !== rightPriority) return rightPriority - leftPriority;
    if (leftPriority != null && rightPriority == null) return -1;
    if (rightPriority != null && leftPriority == null) return 1;
    const categoryOrder = categoryPriorityScore(left, settings) - categoryPriorityScore(right, settings);
    if (categoryOrder !== 0) return categoryOrder;
    const leftEnd = left.endsAt ? Date.parse(left.endsAt) : Number.MAX_SAFE_INTEGER;
    const rightEnd = right.endsAt ? Date.parse(right.endsAt) : Number.MAX_SAFE_INTEGER;
    return leftEnd - rightEnd;
  });
}

export function prioritiesFromOrder(campaigns: Array<{ id: string }>): Record<string, number> {
  return Object.fromEntries(campaigns.map((campaign, index) => [campaign.id, campaigns.length - index]));
}

export function gameItemsFromCampaigns(campaigns: DropCampaign[], t: TFunction): GameItem[] {
  const discovered = new Map<string, GameItem>();
  campaigns.forEach((campaign, index) => {
    const id = gameId(campaign);
    if (!discovered.has(id)) {
      discovered.set(id, {
        id,
        name: campaign.gameName ?? t("unknownGame"),
        short: initials(campaign.gameName ?? campaign.name),
        accent: GAME_ACCENTS[index % GAME_ACCENTS.length],
      });
    }
  });
  return [...discovered.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function categoryPriorityScore(campaign: DropCampaign, settings: ExtensionSettings): number {
  const platformSettings = settings.platform[campaign.platform];
  if (platformSettings.farmAllCategories) return Number.MAX_SAFE_INTEGER;
  const index = categoryListIndex(campaign, platformSettings.categories);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function categoryListIndex(campaign: DropCampaign, list: CategorySelection[]): number {
  if (list.length === 0) return -1;
  const candidates = [campaign.categoryId, campaign.gameName]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  if (candidates.length === 0) return -1;
  return list.findIndex((category) =>
    candidates.includes(category.id.toLowerCase()) || candidates.includes(category.name.toLowerCase()));
}

function gameId(campaign: DropCampaign): string {
  return (campaign.categoryId ?? campaign.gameName ?? campaign.name).trim().toLowerCase();
}

export function fallbackGame(campaign: DropCampaign | CampaignView, index: number, t: TFunction): GameItem {
  const id = "gameId" in campaign ? campaign.gameId : gameId(campaign);
  const name = "title" in campaign ? t("dropsCampaign") : campaign.gameName ?? t("dropsCampaign");
  const short = "thumbnail" in campaign ? campaign.thumbnail : initials(campaign.gameName ?? campaign.name);
  return { id, name, short, accent: GAME_ACCENTS[Math.max(0, index) % GAME_ACCENTS.length] };
}

export function campaignStats(campaign: CampaignView) {
  const totalRequired = campaign.rewards.reduce((sum, reward) => sum + reward.requiredMinutes, 0);
  const totalFarmed = campaign.rewards.reduce((sum, reward) => sum + (reward.requiredMinutes * reward.progress) / 100, 0);
  const remaining = Math.max(totalRequired - totalFarmed, 0);
  const progress = totalRequired ? Math.min(100, (totalFarmed / totalRequired) * 100) : 0;
  const completed = campaign.rewards.filter((reward) => reward.obtained || reward.progress >= 100).length;
  const nextReward = campaign.rewards.find((reward) => !reward.obtained && reward.progress < 100) ?? campaign.rewards.at(-1);
  const complete = campaign.rewards.length > 0 && progress >= 100;
  return { totalRequired, totalFarmed, remaining, progress, completed, totalRewards: campaign.rewards.length, nextReward, complete };
}

export function campaignViewFromCampaign(campaign: DropCampaign, index: number, session: WatchSession, excluded: boolean): CampaignView {
  const visibleChannels = channelsForView(campaign);
  return {
    id: campaign.id,
    gameId: gameId(campaign),
    title: campaign.name,
    status: campaign.status,
    lifecycle: campaignLifecycleState(campaign),
    linked: campaign.accountLinked !== false,
    excluded,
    starts: campaign.startsAt ?? campaign.rewards.find((reward) => reward.availableFrom)?.availableFrom ?? "",
    ends: campaign.endsAt ?? campaign.rewards.find((reward) => reward.availableUntil)?.availableUntil ?? "",
    allowedChannels: visibleChannels.channels,
    moreChannels: visibleChannels.more,
    farmingChannel: session.campaignId === campaign.id ? channelViewFromSession(session) : undefined,
    thumbnail: initials(campaign.gameName ?? campaign.name),
    tint: CAMPAIGN_TINTS[index % CAMPAIGN_TINTS.length],
    imageUrl: campaign.gameImageUrl,
    rewards: campaign.rewards.map((reward, rewardIndex) => {
      const progress = reward.requiredMinutes > 0
        ? Math.min(100, (Math.min(reward.watchedMinutes, reward.requiredMinutes) / reward.requiredMinutes) * 100)
        : reward.status === "claimed" ? 100 : 0;
      return {
        id: reward.id,
        name: reward.name,
        progress,
        requiredMinutes: reward.requiredMinutes,
        obtained: reward.status === "claimed",
        art: initials(reward.name).slice(0, 8),
        tint: REWARD_TINTS[rewardIndex % REWARD_TINTS.length],
        imageUrl: campaign.platform === "kick" ? kickRewardImageUrl(reward.imageUrl) : reward.imageUrl,
      };
    }),
  };
}

export function campaignLifecycleState(campaign: DropCampaign): CampaignLifecycleState | undefined {
  if (isCampaignFinished(campaign)) return "finished";
  if (isCampaignExpired(campaign)) return "expired";
  if (campaign.status === "upcoming") return "upcoming";
  return undefined;
}

function channelsForView(campaign: DropCampaign): { channels: string[]; more: number } {
  if (campaign.isGeneralDrop || !campaign.allowedChannels?.length) return { channels: ["All"], more: 0 };
  const channels = campaign.allowedChannels.slice(0, 4);
  return { channels, more: Math.max(0, campaign.allowedChannels.length - channels.length) };
}

export function channelViewFromSession(session: WatchSession): FarmingChannelView | undefined {
  if (session.status !== "watching") return undefined;
  const channel = session.channel;
  if (!channel) return undefined;
  return {
    name: channel.displayName ?? channel.username,
    category: channel.categoryName,
    viewers: channel.viewerCount,
  };
}

export function streamerItemFromFallback(username: string, session: WatchSession, t: TFunction): StreamerItem {
  const channel = session.channel;
  const live = channel != null && channel.username.toLowerCase() === username.toLowerCase() && session.status === "watching";
  if (!live) return { id: username, name: username, live: false, subtitle: t("queued") };
  return {
    id: username,
    name: channel.displayName ?? username,
    live: true,
    subtitle: channel.categoryName,
    viewers: channel.viewerCount,
  };
}
