import type { DropCampaign, DropReward } from "@lurkloot/shared/models";
import { applySubscriptionMarks, campaignHasWatchRewards, isRewardObtained, isWaitingSubscriptionReward, rewardRequirementType } from "@lurkloot/shared/rewards";

function subscriptionRequirement(required: number): string {
  return `${required} qualifying ${required === 1 ? "subscription" : "subscriptions"}`;
}

function formatReward(reward: DropReward): string {
  if (reward.status === "claimed") return `  ◦ ${reward.name} — earned`;
  if (isRewardObtained(reward)) return `  ◦ ${reward.name} — subscription marked`;

  switch (rewardRequirementType(reward)) {
    case "subscription": {
      const required = reward.requiredSubs ?? 1;
      return `  ◦ ${reward.name} — requires ${subscriptionRequirement(required)}; progress unavailable`;
    }
    case "watch": {
      const marked = reward.subscriptionMarked ? " (subscription marked)" : "";
      return `  ◦ ${reward.name} — requires ${reward.requiredMinutes} minutes watched${marked}; progress ${reward.watchedMinutes}/${reward.requiredMinutes} minutes`;
    }
    case "action":
      return `  ◦ ${reward.name} — action required; progress unavailable`;
  }
}

// `discover` prints adapter output, which carries no marks, so the config's
// marks are applied here as the engine applies them where campaigns enter it.
export function formatDiscoveredCampaign(source: DropCampaign, marks: readonly string[] = []): string[] {
  const campaign = applySubscriptionMarks(source, marks);
  // From the rewards, not eligibility alone: a campaign whose subscriptions the
  // user marked is no longer waiting.
  const waiting = campaign.eligibility === "waiting_for_subscription"
    && campaign.rewards.some((reward) => isWaitingSubscriptionReward(reward))
    ? " — waiting for subscription"
    : "";
  return [`• ${campaign.name}${waiting}`, ...campaign.rewards.map(formatReward)];
}

export function subscriptionWaitKeys(campaigns: DropCampaign[]): Map<string, string> {
  const waits = new Map<string, string>();
  for (const campaign of campaigns) {
    if (!campaignCanWaitForSubscription(campaign)) continue;
    for (const reward of campaign.rewards) {
      if (!isWaitingSubscriptionReward(reward)) continue;
      const required = reward.requiredSubs ?? 1;
      waits.set(
        `${campaign.platform}:${campaign.id}:${reward.id}`,
        `Waiting for ${subscriptionRequirement(required)}: ${reward.name} from ${campaign.name}`,
      );
    }
  }
  return waits;
}

function campaignCanWaitForSubscription(campaign: DropCampaign): boolean {
  if (campaign.status !== "active" || campaign.accountLinked === false) return false;
  const genuinelyWaiting = campaign.eligibility === "waiting_for_subscription"
    || (campaign.eligibility === "eligible" && campaignHasWatchRewards(campaign));
  if (!genuinelyWaiting) return false;
  const now = Date.now();
  const startsAt = campaign.startsAt ? Date.parse(campaign.startsAt) : undefined;
  const endsAt = campaign.endsAt ? Date.parse(campaign.endsAt) : undefined;
  if (startsAt != null && !Number.isNaN(startsAt) && now < startsAt) return false;
  if (endsAt != null && !Number.isNaN(endsAt) && now >= endsAt) return false;
  return true;
}
