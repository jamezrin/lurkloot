import type { CampaignFilterKey, DisplayFilterKey, DropCampaign, EngineSettings, ExtensionSettings, FarmingFilterKey } from "./models";
import { campaignHasSubscriptionRewards } from "./rewards";

export const FARMING_FILTER_KEYS: FarmingFilterKey[] = ["notLinked", "subscription"];
export const DISPLAY_FILTER_KEYS: DisplayFilterKey[] = ["upcoming", "expired", "excluded", "finished"];
export const CAMPAIGN_FILTER_KEYS: CampaignFilterKey[] = [...FARMING_FILTER_KEYS, ...DISPLAY_FILTER_KEYS];

export function isCampaignExpired(campaign: DropCampaign): boolean {
  if (campaign.status === "expired") return true;
  return hasCampaignEnded(campaign);
}

// Shared with the scheduler so "has this ended" has one definition.
export function hasCampaignEnded(campaign: DropCampaign): boolean {
  if (!campaign.endsAt) return false;
  const endsAt = Date.parse(campaign.endsAt);
  return !Number.isNaN(endsAt) && endsAt < Date.now();
}

export function isCampaignFinished(campaign: DropCampaign): boolean {
  if (campaign.status === "completed") return true;
  return campaign.rewards.length > 0 && campaign.rewards.every((reward) => reward.status === "claimed");
}

export function campaignFilterCategories(campaign: DropCampaign, excludedIds: ReadonlySet<string>): CampaignFilterKey[] {
  const categories: CampaignFilterKey[] = [];
  if (excludedIds.has(campaign.id)) categories.push("excluded");
  if (campaign.accountLinked === false) categories.push("notLinked");
  if (campaignHasSubscriptionRewards(campaign)) categories.push("subscription");
  if (isCampaignFinished(campaign)) categories.push("finished");
  else if (isCampaignExpired(campaign)) categories.push("expired");
  else if (campaign.status === "upcoming") categories.push("upcoming");
  return categories;
}

// What the engine asks: is this campaign's class allowed to be farmed? Reads
// only the two eligibility flags; excludedCampaignIds is handled separately in
// isEligible, so it is not consulted here. Threading exclusions through would
// imply this filter has an opinion about them.
export function campaignPassesFarmingEligibility(
  campaign: DropCampaign,
  farmingEligibility: EngineSettings["farmingEligibility"],
): boolean {
  if (campaign.accountLinked === false && !farmingEligibility.farmUnlinkedCampaigns) return false;
  if (campaignHasSubscriptionRewards(campaign) && !farmingEligibility.farmSubscriptionCampaigns) return false;
  return true;
}

// What the popup asks. A claimable reward always stays visible so the user can
// claim it. Link status and subscription NEVER affect visibility — a campaign
// you have chosen not to farm still appears in the list. The finished/expired/
// upcoming order mirrors the precedence in campaignFilterCategories.
export function isCampaignVisible(
  campaign: DropCampaign,
  filter: ExtensionSettings["dropsListFilter"],
  excludedIds: ReadonlySet<string>,
): boolean {
  if (campaign.rewards.some((reward) => reward.status === "claimable")) return true;
  if (excludedIds.has(campaign.id) && !filter.showExcluded) return false;
  if (isCampaignFinished(campaign)) return filter.showFinished;
  if (isCampaignExpired(campaign)) return filter.showExpired;
  if (campaign.status === "upcoming") return filter.showUpcoming;
  return true;
}
