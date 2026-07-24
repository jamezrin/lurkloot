import type { CampaignFilterKey, DropCampaign, EngineSettings, ExtensionSettings } from "./models";
import { campaignHasSubscriptionRewards } from "./rewards";

export function isCampaignExpired(campaign: DropCampaign): boolean {
  if (campaign.status === "expired") return true;
  // The engine also treats these eligibility values as lifecycle states, so the
  // display categorisation must agree or a campaign the engine considers ended
  // could still slip past a showExpired: false filter. All three are non-farmable
  // (isEligible rejects any eligibility !== "eligible"), so aligning display to
  // them can never hide a campaign the engine would farm.
  if (campaign.eligibility === "expired") return true;
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
  // Mirror the engine's lifecycle view (see isCampaignExpired): a "completed"
  // eligibility is a finished campaign even when status is still "active". Also
  // non-farmable, so this cannot hide a farmable campaign.
  if (campaign.eligibility === "completed") return true;
  return campaign.rewards.length > 0 && campaign.rewards.every((reward) => reward.status === "claimed");
}

// Whether the campaign is upcoming — not yet started, nothing earnable now. The
// engine treats both status "upcoming" and eligibility "upcoming" as such, so
// the display categorisation matches. Non-farmable, so filtering it cannot hide
// a farmable campaign.
export function isCampaignUpcoming(campaign: DropCampaign): boolean {
  return campaign.status === "upcoming" || campaign.eligibility === "upcoming";
}

export function campaignFilterCategories(campaign: DropCampaign, excludedIds: ReadonlySet<string>): CampaignFilterKey[] {
  const categories: CampaignFilterKey[] = [];
  if (excludedIds.has(campaign.id)) categories.push("excluded");
  if (campaign.accountLinked === false) categories.push("notLinked");
  if (campaignHasSubscriptionRewards(campaign)) categories.push("subscription");
  if (isCampaignFinished(campaign)) categories.push("finished");
  else if (isCampaignExpired(campaign)) categories.push("expired");
  else if (isCampaignUpcoming(campaign)) categories.push("upcoming");
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
// claim it. The finished/expired/upcoming order mirrors the precedence in
// campaignFilterCategories. Not-linked and subscription campaigns can be hidden
// via their display flags, but ONLY when they are not being farmed.
//
// INVARIANT: a campaign that will be farmed is always visible here. The user
// must never farm a campaign they cannot see. For the four lifecycle/excluded
// states this holds structurally: none of them is farmable — isEligible rejects
// an inactive/ended campaign and any campaign whose eligibility !== "eligible",
// and an excluded id is rejected outright — so no farmable campaign can reach
// those filtered branches. For the two class states (not-linked, subscription)
// it is enforced explicitly: the hide only fires when farming of that class is
// OFF, so farming-on forces the campaign visible (farming-on OR show-flag-on).
// The claimable-reward escape hatch above additionally keeps any campaign the
// user can still claim visible, covering ended campaigns with an unclaimed
// reward. If a future change makes a farmable campaign hideable, the binding
// test in campaignFilters.test.ts fails.
export function isCampaignVisible(
  campaign: DropCampaign,
  filter: ExtensionSettings["dropsListFilter"],
  farmingEligibility: EngineSettings["farmingEligibility"],
  excludedIds: ReadonlySet<string>,
): boolean {
  if (campaign.rewards.some((reward) => reward.status === "claimable")) return true;
  if (excludedIds.has(campaign.id) && !filter.showExcluded) return false;
  if (isCampaignFinished(campaign)) return filter.showFinished;
  if (isCampaignExpired(campaign)) return filter.showExpired;
  if (isCampaignUpcoming(campaign)) return filter.showUpcoming;
  // Active campaign. A not-linked / subscription campaign may be hidden ONLY
  // when it is not being farmed — the user can never hide something farmed (the
  // visibility invariant), so farming-on forces it visible regardless of the
  // display flag.
  if (campaign.accountLinked === false && !farmingEligibility.farmUnlinkedCampaigns && !filter.showNotLinked) return false;
  if (campaignHasSubscriptionRewards(campaign) && !farmingEligibility.farmSubscriptionCampaigns && !filter.showSubscription) return false;
  return true;
}
