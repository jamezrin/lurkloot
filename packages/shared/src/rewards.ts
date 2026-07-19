import type { DropCampaign, DropReward, RewardRequirementType } from "./models";

type RequirementFields = Pick<DropReward, "requirement" | "requiredMinutes" | "requiredSubs" | "isWatchBased">;

export function rewardRequirementType(reward: RequirementFields): RewardRequirementType {
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

export function rewardFeasibility(
  campaign: Pick<DropCampaign, "endsAt">,
  reward: DropReward,
  marginMinutes: number,
  now = Date.now(),
): RewardFeasibility {
  if (marginMinutes === -1) return { kind: "disabled" };
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
  const requiredMilliseconds = (remainingMinutes + marginMinutes) * 60_000;
  const kind = availableMilliseconds >= requiredMilliseconds ? "feasible" : "insufficient_time";
  return {
    kind,
    deadline: earliest.deadline,
    remainingMinutes,
    availableMilliseconds,
    marginMinutes,
  };
}

export function isWaitingSubscriptionReward(reward: DropReward, now = Date.now()): boolean {
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

export function reconcileCampaignAfterClaims(campaign: DropCampaign, rewards: DropReward[]): DropCampaign {
  const claimedIds = new Set(
    rewards.filter((reward) => reward.status === "claimed").map((reward) => reward.id),
  );
  const reconciledRewards = rewards.map((reward) => ({
    ...reward,
    preconditionsMet: (reward.preconditionRewardIds ?? []).every((id) => claimedIds.has(id)),
  }));
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
