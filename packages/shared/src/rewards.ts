import type { DropCampaign, DropReward, RewardRequirementType } from "./models";

type RequirementFields = Pick<DropReward, "requirement" | "requiredMinutes" | "requiredSubs" | "isWatchBased" | "subscriptionMarked">;

export function rewardRequirementType(reward: RequirementFields): RewardRequirementType {
  // A subscription the user marked as made leaves only the watch time to earn.
  if (reward.subscriptionMarked && reward.requiredMinutes > 0) return "watch";
  if (reward.requirement) return reward.requirement;
  if ((reward.requiredSubs ?? 0) > 0) return "subscription";
  if (reward.requiredMinutes > 0 && reward.isWatchBased !== false) return "watch";
  return "action";
}

export const isWatchReward = (reward: RequirementFields): boolean => rewardRequirementType(reward) === "watch";
export const isSubscriptionReward = (reward: RequirementFields): boolean => rewardRequirementType(reward) === "subscription";

export type RewardFeasibility =
  | { kind: "disabled" }
  | { kind: "not_applicable" }
  | { kind: "unknown_deadline" }
  | { kind: "feasible"; deadline: string; remainingMinutes: number; availableMilliseconds: number; marginMinutes: number }
  | { kind: "insufficient_time"; deadline: string; remainingMinutes: number; availableMilliseconds: number; marginMinutes: number };

export const EXACT_FIT_WINDOW_TOLERANCE_MS = 5_000;
export const EXACT_FIT_LAUNCH_ALLOWANCE_MS = 15_000;

function isKickExactFitLaunch(
  campaign: Pick<DropCampaign, "platform">,
  reward: DropReward,
  now: number,
  availableMilliseconds: number,
  remainingMilliseconds: number,
): boolean {
  if (campaign.platform !== "kick" || !reward.availableFrom || !reward.availableUntil) return false;
  const startsAt = Date.parse(reward.availableFrom);
  const endsAt = Date.parse(reward.availableUntil);
  if (Number.isNaN(startsAt) || Number.isNaN(endsAt)) return false;

  const fullWindow = endsAt - startsAt;
  const fullRequirement = reward.requiredMinutes * 60_000;
  if (Math.abs(fullWindow - fullRequirement) > EXACT_FIT_WINDOW_TOLERANCE_MS) return false;

  const elapsedSinceLaunch = now - startsAt;
  if (elapsedSinceLaunch < 0 || elapsedSinceLaunch > EXACT_FIT_LAUNCH_ALLOWANCE_MS) return false;

  return remainingMilliseconds - availableMilliseconds <= elapsedSinceLaunch;
}

export function rewardFeasibility(
  campaign: Pick<DropCampaign, "endsAt" | "platform">,
  reward: DropReward,
  enabled: boolean,
  marginMinutes: number,
  now = Date.now(),
): RewardFeasibility {
  if (!enabled) return { kind: "disabled" };
  if (!isWatchReward(reward) || reward.status === "claimed" || reward.status === "claimable") {
    return { kind: "not_applicable" };
  }

  const deadlines = [campaign.endsAt, reward.availableUntil]
    .flatMap((deadline) => {
      if (!deadline) return [];
      const timestamp = Date.parse(deadline);
      return Number.isNaN(timestamp) ? [] : [{ deadline, timestamp }];
    })
    .sort((left, right) => left.timestamp - right.timestamp);
  const earliest = deadlines[0];
  if (!earliest) return { kind: "unknown_deadline" };

  const remainingMinutes = Math.max(0, reward.requiredMinutes - reward.watchedMinutes);
  const availableMilliseconds = earliest.timestamp - now;
  const remainingMilliseconds = remainingMinutes * 60_000;
  const requiredMilliseconds = remainingMilliseconds + marginMinutes * 60_000;
  const kind = availableMilliseconds >= requiredMilliseconds
    || isKickExactFitLaunch(campaign, reward, now, availableMilliseconds, remainingMilliseconds)
    ? "feasible"
    : "insufficient_time";
  return {
    kind,
    deadline: earliest.deadline,
    remainingMinutes,
    availableMilliseconds,
    marginMinutes,
  };
}

// A watch reward not yet claimable but still within its earn window — the
// scheduler picks these to actively watch. Shared with the popup's farmability
// check (campaignFarmable) so both agree on what "still earning" means.
export function isRewardAvailableToEarn(reward: DropReward, now = Date.now()): boolean {
  if (!isWatchReward(reward)) return false;
  const startsAt = reward.availableFrom ? Date.parse(reward.availableFrom) : undefined;
  const endsAt = reward.availableUntil ? Date.parse(reward.availableUntil) : undefined;
  if (startsAt != null && !Number.isNaN(startsAt) && now < startsAt) return false;
  if (endsAt != null && !Number.isNaN(endsAt) && now >= endsAt) return false;
  // A marked reward whose watch time is done but which the platform has not
  // released can only be moved on by the platform, not by more watching.
  if (reward.subscriptionMarked && reward.watchedMinutes >= reward.requiredMinutes) return false;
  return reward.status !== "claimed" && reward.status !== "claimable";
}

export function canClaimReward(reward: DropReward, now = Date.now()): boolean {
  if (reward.status !== "claimable") return false;
  if (!reward.claimUntil) return true;
  const claimUntil = Date.parse(reward.claimUntil);
  return Number.isNaN(claimUntil) || now < claimUntil;
}

export function isRewardRelevantNow(reward: DropReward, now = Date.now()): boolean {
  return canClaimReward(reward, now) || isRewardAvailableToEarn(reward, now);
}

export function isRewardDeadlineFeasible(
  campaign: Pick<DropCampaign, "endsAt" | "platform">,
  reward: DropReward,
  enabled: boolean,
  marginMinutes: number,
): boolean {
  return rewardFeasibility(campaign, reward, enabled, marginMinutes).kind !== "insufficient_time";
}

export function isWaitingSubscriptionReward(reward: DropReward, now = Date.now()): boolean {
  if (reward.subscriptionMarked) return false;
  if (!isSubscriptionReward(reward)) return false;
  if (reward.status !== "locked" && reward.status !== "in_progress") return false;
  if (reward.preconditionsMet === false) return false;
  const startsAt = reward.availableFrom ? Date.parse(reward.availableFrom) : undefined;
  const endsAt = reward.availableUntil ? Date.parse(reward.availableUntil) : undefined;
  if (startsAt != null && !Number.isNaN(startsAt) && now < startsAt) return false;
  if (endsAt != null && !Number.isNaN(endsAt) && now >= endsAt) return false;
  return true;
}

export const campaignHasWatchRewards = (campaign: Pick<DropCampaign, "rewards">): boolean => campaign.rewards.some(isWatchReward);
export const campaignHasSubscriptionRewards = (campaign: Pick<DropCampaign, "rewards">): boolean => campaign.rewards.some(isSubscriptionReward);

// Subscription marks (docs/superpowers/specs/2026-10-03-subscription-marks-design.md).
// A mark is the user's word that a subscription reward's subscription was made.
// It lives on rewards only and never changes a reward's or campaign's status,
// so removing it restores the platform's view exactly.
export function subscriptionMarkKey(campaignId: string, rewardId: string): string {
  return `${campaignId}:${rewardId}`;
}

// Only a subscription reward the platform has not released or confirmed: once
// it is claimable it is claimed for real, and a mark would only hide that.
export function canMarkSubscription(reward: Pick<DropReward, "requiredSubs" | "status">): boolean {
  return (reward.requiredSubs ?? 0) > 0 && (reward.status === "locked" || reward.status === "in_progress");
}

// Done, as far as Lurkloot's decisions go: claimed on the platform, or a pure
// subscription reward the user marked. A marked reward that also needs watch
// time is a watch reward instead (rewardRequirementType).
export function isRewardObtained(reward: Pick<DropReward, "status" | "subscriptionMarked" | "requiredMinutes">): boolean {
  return reward.status === "claimed" || (reward.subscriptionMarked === true && reward.requiredMinutes === 0);
}

function reconcilePreconditions(rewards: DropReward[]): DropReward[] {
  const obtainedIds = new Set(rewards.filter(isRewardObtained).map((reward) => reward.id));
  return rewards.map((reward) => ({
    ...reward,
    preconditionsMet: (reward.preconditionRewardIds ?? []).every((id) => obtainedIds.has(id)),
  }));
}

export function applySubscriptionMarks(campaign: DropCampaign, marks: readonly string[]): DropCampaign {
  const prefix = subscriptionMarkKey(campaign.id, "");
  // No mark names this campaign and none is left to clear: the platform's view,
  // as the same object, so stored state does not change.
  if (!marks.some((mark) => mark.startsWith(prefix)) && !campaign.rewards.some((reward) => reward.subscriptionMarked)) {
    return campaign;
  }
  const marked = new Set(marks);
  const rewards = campaign.rewards.map(({ subscriptionMarked: _previous, ...reward }): DropReward =>
    canMarkSubscription(reward) && marked.has(subscriptionMarkKey(campaign.id, reward.id))
      ? { ...reward, subscriptionMarked: true }
      : reward);
  return { ...campaign, rewards: reconcilePreconditions(rewards) };
}

export function reconcileCampaignAfterClaims(campaign: DropCampaign, rewards: DropReward[]): DropCampaign {
  const reconciledRewards = reconcilePreconditions(rewards);
  // Completion stays on the platform's claims: it writes the campaign's status
  // one way, which a mark must never do.
  const completed = reconciledRewards.length > 0
    && reconciledRewards.every((reward) => reward.status === "claimed");

  return {
    ...campaign,
    rewards: reconciledRewards,
    status: completed ? "completed" : campaign.status,
    eligibility: completed ? "completed" : campaign.eligibility,
    eligibilityReason: completed ? "All rewards are claimed" : campaign.eligibilityReason,
  };
}
