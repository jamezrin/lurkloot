import { campaignPassesCategoryFilter } from "./categories";
import { evaluateCampaignFarming } from "./campaignFarming";
import type { CampaignFilterKey, DropCampaign, DropReward, EngineSettings } from "./models";
import { campaignHasSubscriptionRewards, canClaimReward, isRewardDeadlineFeasible, isRewardRelevantNow } from "./rewards";

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
  if ((campaign.accountLinked === false || campaign.eligibility === "account_not_linked")
    && !farmingEligibility.farmUnlinkedCampaigns) return false;
  if (campaignHasSubscriptionRewards(campaign) && !farmingEligibility.farmSubscriptionCampaigns) return false;
  return true;
}

// Whether a single reward is farmable right now: not yet claimed, its earn/claim
// preconditions are met, it is within its claim or earn window, and — for a
// still-earning watch reward — its deadline is feasible under the user's
// skip-unfinishable-rewards policy. Shared by campaignFarmable (below) and the
// scheduler, so "should the engine spend a tick on this reward" has one
// definition instead of drifting between the two.
export function isRewardFarmableNow(
  campaign: Pick<DropCampaign, "endsAt" | "platform">,
  reward: DropReward,
  settings: Pick<EngineSettings, "skipUnfinishableRewards" | "deadlineSafetyMarginMinutes">,
): boolean {
  if (reward.status === "claimed") return false;
  if (reward.preconditionsMet === false) return false;
  if (!isRewardRelevantNow(reward)) return false;
  return canClaimReward(reward)
    || isRewardDeadlineFeasible(campaign, reward, settings.skipUnfinishableRewards, settings.deadlineSafetyMarginMinutes);
}

// Whether a campaign's CLASS could ever be farmed, ignoring the moment-to-moment
// timing of any individual reward (deadline feasibility, preconditions). This is
// everything campaignFarmable checks except the final per-reward relevance
// check, replaced with the much looser "has something left to earn or claim at
// all". Deliberately separate from campaignFarmable: a campaign that is
// momentarily un-farmable for reward-timing reasons (an infeasible deadline
// under skipUnfinishableRewards, an unmet precondition on a locked follow-up
// reward) is not a dead campaign — the user may want to see it, ease the
// deadline margin, or pin it — so the popup keeps showing it, in the Skipped
// group, with the reason the evaluation gave.
export function campaignEligibleClass(campaign: DropCampaign, settings: EngineSettings): boolean {
  if (campaign.status !== "active") return false;
  if (hasCampaignEnded(campaign)) return false;
  if (campaign.eligibility && campaign.eligibility !== "eligible" && campaign.eligibility !== "account_not_linked") return false;
  if (settings.excludedCampaignIds.includes(campaign.id)) return false;
  if (!campaignPassesFarmingEligibility(campaign, settings.farmingEligibility)) return false;
  if (!campaignPassesCategoryFilter(campaign, settings.platform[campaign.platform])) return false;
  // Linking is required for game delivery; the farming flag controls watch eligibility.
  return campaign.rewards.some((reward) => reward.status !== "claimed");
}

// The single definition of "is this campaign farmable right now" — everything
// the engine's isEligible checks EXCEPT the farmPinnedOnly switch. That switch
// is a farming-strategy choice, not a fact about the campaign itself: a campaign
// the user has not pinned yet must stay eligible-class here so the popup can
// still list it (as Skipped, with "not pinned" as the reason) and offer the pin.
// Strictly narrower than campaignEligibleClass.
export function campaignFarmable(campaign: DropCampaign, settings: EngineSettings): boolean {
  return evaluateCampaignFarming(campaign, settings).farmable;
}

// Which section of the popup a campaign belongs to. One definition shared by
// the popup's Queue, Skipped, Upcoming and Completed lists, so a campaign can
// never be in two of them — and never missing from all four, which is what the
// old per-class display toggles allowed.
//
// INVARIANT: a campaign the engine will farm is always in "queue", because the
// queue test is the engine's own evaluateCampaignFarming.
export type CampaignSection = "queue" | "skipped" | "upcoming" | "completed" | "expired";

export function campaignSection(campaign: DropCampaign, settings: EngineSettings): CampaignSection {
  if (isCampaignFinished(campaign)) return "completed";
  if (isCampaignExpired(campaign)) return "expired";
  if (isCampaignUpcoming(campaign)) return "upcoming";
  return evaluateCampaignFarming(campaign, settings, { includePinnedOnly: true }).farmable ? "queue" : "skipped";
}
