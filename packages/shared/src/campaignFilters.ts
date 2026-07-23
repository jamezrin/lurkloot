import type { CampaignFilterKey, DisplayFilterKey, DropCampaign, FarmingFilterKey } from "./models";
import { campaignHasSubscriptionRewards } from "./rewards";

export const FARMING_FILTER_KEYS: FarmingFilterKey[] = ["notLinked", "subscription"];
export const DISPLAY_FILTER_KEYS: DisplayFilterKey[] = ["upcoming", "expired", "excluded", "finished"];
export const CAMPAIGN_FILTER_KEYS: CampaignFilterKey[] = [...FARMING_FILTER_KEYS, ...DISPLAY_FILTER_KEYS];

// No campaign is excluded when the question is "may the engine farm this?" —
// exclusion is enforced separately by excludedCampaignIds in isEligible.
const NO_EXCLUSIONS: ReadonlySet<string> = new Set<string>();

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

// What the engine asks. Takes no excludedIds on purpose: the only keys it reads
// are notLinked and subscription, and isEligible rejects excluded campaigns on
// its own line. Threading exclusions through here would imply this filter has an
// opinion about them.
export function campaignPassesFarmingFilters(
  campaign: DropCampaign,
  filters: Record<CampaignFilterKey, boolean>,
): boolean {
  return campaignFilterCategories(campaign, NO_EXCLUSIONS)
    .filter((key): key is FarmingFilterKey => (FARMING_FILTER_KEYS as CampaignFilterKey[]).includes(key))
    .every((key) => filters[key]);
}

// What the popup asks. A claimable reward always stays visible so the user can
// claim it; that escape hatch must never reach the farming predicate.
export function isCampaignVisible(
  campaign: DropCampaign,
  filters: Record<CampaignFilterKey, boolean>,
  excludedIds: ReadonlySet<string>,
): boolean {
  if (campaign.rewards.some((reward) => reward.status === "claimable")) return true;
  return campaignFilterCategories(campaign, excludedIds).every((key) => filters[key]);
}
