import { categoryListIndex } from "./categories";
import type { CampaignFilterKey, DropCampaign, DropReward, EngineSettings, ExtensionSettings } from "./models";
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
  if (campaign.accountLinked === false && !farmingEligibility.farmUnlinkedCampaigns) return false;
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
  campaign: Pick<DropCampaign, "endsAt">,
  reward: DropReward,
  settings: Pick<EngineSettings, "skipUnfinishableRewards" | "deadlineSafetyMarginMinutes">,
): boolean {
  if (reward.status === "claimed") return false;
  if (reward.preconditionsMet === false) return false;
  if (!isRewardRelevantNow(reward)) return false;
  return canClaimReward(reward)
    || isRewardDeadlineFeasible(campaign, reward, settings.skipUnfinishableRewards, settings.deadlineSafetyMarginMinutes);
}

// The single definition of "is this campaign farmable right now" — everything
// the engine's isEligible checks EXCEPT settings.priorityMode. Priority-list-only
// mode is a farming-strategy choice, not a fact about the campaign itself: a
// campaign the user hasn't prioritized yet must stay farmable-shaped here (and
// visible in isCampaignVisible below) so they can add it to the list, which is
// why the scheduler layers that check on top of this rather than folding it in.
export function campaignFarmable(campaign: DropCampaign, settings: EngineSettings): boolean {
  if (campaign.status !== "active") return false;
  if (hasCampaignEnded(campaign)) return false;
  if (campaign.eligibility && campaign.eligibility !== "eligible") return false;
  if (settings.excludedCampaignIds.includes(campaign.id)) return false;
  if (!campaignPassesFarmingEligibility(campaign, settings.farmingEligibility)) return false;
  const platformSettings = settings.platform[campaign.platform];
  if (!platformSettings.farmAllCategories && categoryListIndex(campaign, platformSettings.categories) === -1) return false;
  // Twitch cannot earn drops until the account is linked, so an unlinked Twitch
  // campaign is never farmable regardless of farmUnlinkedCampaigns. Kick DOES
  // accrue watch progress before linking (the link is only required to claim).
  if (campaign.platform !== "kick" && campaign.accountLinked === false) return false;
  return campaign.rewards.some((reward) => isRewardFarmableNow(campaign, reward, settings));
}

// What the popup asks. A claimable reward always stays visible so the user can
// claim it, independent of farmability — claiming doesn't require the engine to
// be actively farming the campaign. Everything else derives from a single
// question, "is this campaign farmable right now" (campaignFarmable): if yes,
// visible (the invariant below); if no, visible only when a display flag
// explicitly says to show that class of non-farmable campaign anyway.
//
// INVARIANT: a campaign that will be farmed is always visible here. The user
// must never farm a campaign they cannot see. This holds by construction: the
// first campaignFarmable(...) check returns true immediately, before any
// filter flag is consulted, so no flag can hide a farmable campaign. If a
// future change reorders this, the binding test in campaignFilters.test.ts
// fails.
export function isCampaignVisible(
  campaign: DropCampaign,
  settings: ExtensionSettings,
  excludedIds: ReadonlySet<string>,
): boolean {
  if (campaign.rewards.some((reward) => reward.status === "claimable")) return true;
  if (campaignFarmable(campaign, settings)) return true;
  // Not farmable right now. Bucket by why, and consult that class's display
  // flag — the only way a non-farmable campaign can still be shown.
  const filter = settings.dropsListFilter;
  if (excludedIds.has(campaign.id)) return filter.showExcluded;
  if (isCampaignFinished(campaign)) return filter.showFinished;
  if (isCampaignExpired(campaign)) return filter.showExpired;
  if (isCampaignUpcoming(campaign)) return filter.showUpcoming;
  if (campaign.accountLinked === false) return filter.showNotLinked;
  if (campaignHasSubscriptionRewards(campaign)) return filter.showSubscription;
  // An ordinary active campaign that campaignFarmable rejected for a reason with
  // no display flag (category filter, or every reward currently unearnable/
  // infeasible) has none to fall back on: hidden.
  return false;
}
