import type { DropCampaign, DropReward } from "@lurkloot/shared/models";
import { campaignHasWatchRewards, isWaitingSubscriptionReward, rewardRequirementType } from "@lurkloot/shared/rewards";

function subscriptionRequirement(required: number): string {
  return `${required} qualifying ${required === 1 ? "subscription" : "subscriptions"}`;
}

function formatReward(reward: DropReward): string {
  if (reward.status === "claimed") return `  ◦ ${reward.name} — earned`;

  switch (rewardRequirementType(reward)) {
    case "subscription": {
      const required = reward.requiredSubs ?? 1;
      return `  ◦ ${reward.name} — requires ${subscriptionRequirement(required)}; progress unavailable`;
    }
    case "watch":
      return `  ◦ ${reward.name} — requires ${reward.requiredMinutes} minutes watched; progress ${reward.watchedMinutes}/${reward.requiredMinutes} minutes`;
    case "action":
      return `  ◦ ${reward.name} — action required; progress unavailable`;
  }
}

export function formatDiscoveredCampaign(campaign: DropCampaign): string[] {
  const waiting = campaign.eligibility === "waiting_for_subscription" ? " — waiting for subscription" : "";
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
