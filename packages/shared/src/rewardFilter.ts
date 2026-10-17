import type {
  DropCampaign,
  DropReward,
  Platform,
  RewardFilter,
  RewardFilterMiss,
  RewardKind,
  SubscriptionRewardMode,
} from "./models";
import { rewardRequiresSubscription } from "./rewards";

export const REWARD_KINDS: readonly RewardKind[] = ["item", "badge", "emote"];

export const PLATFORM_REWARD_KINDS: Record<Platform, readonly RewardKind[]> = {
  twitch: ["item", "badge", "emote"],
  kick: ["item"],
};

export const SUBSCRIPTION_REWARD_MODES: readonly SubscriptionRewardMode[] = [
  "include",
  "skip",
  "only",
];

export function defaultRewardFilter(platform: Platform): RewardFilter {
  return { kinds: [...PLATFORM_REWARD_KINDS[platform]], subscriptions: "include" };
}

export function normalizeRewardFilter(value: unknown, platform: Platform): RewardFilter {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const supported = PLATFORM_REWARD_KINDS[platform];
  const requested = Array.isArray(record.kinds) ? record.kinds : [];
  const kinds = REWARD_KINDS.filter((kind) => supported.includes(kind) && requested.includes(kind));
  const subscriptions = SUBSCRIPTION_REWARD_MODES.find((mode) => mode === record.subscriptions);
  return {
    kinds: kinds.length > 0 ? kinds : [...supported],
    subscriptions: subscriptions ?? "include",
  };
}

export function isRewardFilterNarrowed(filter: RewardFilter, platform: Platform): boolean {
  const normalized = normalizeRewardFilter(filter, platform);
  return (
    normalized.subscriptions !== "include"
    || normalized.kinds.length < PLATFORM_REWARD_KINDS[platform].length
  );
}

export function rewardKinds(reward: Pick<DropReward, "benefits" | "benefitType">): RewardKind[] {
  const types = reward.benefits
    ? reward.benefits.map((benefit) => benefit.distributionType)
    : [reward.benefitType];
  const kinds = new Set<RewardKind>(
    types.map((type) => (type === "BADGE" ? "badge" : type === "EMOTE" ? "emote" : "item")),
  );
  if (kinds.size === 0) kinds.add("item");
  return [...kinds];
}

export function rewardMatchesFilter(reward: DropReward, filter: RewardFilter): boolean {
  if (!rewardKinds(reward).some((kind) => filter.kinds.includes(kind))) return false;
  return subscriptionMatches(reward, filter.subscriptions);
}

function subscriptionMatches(reward: DropReward, mode: SubscriptionRewardMode): boolean {
  if (mode === "include") return true;
  const requires = rewardRequiresSubscription(reward);
  // A marked subscription is the user's word it was made: skip lets it through.
  if (mode === "skip") return !requires || reward.subscriptionMarked === true;
  return requires;
}

export function campaignFilterMiss(
  campaign: Pick<DropCampaign, "rewards">,
  filter: RewardFilter,
): RewardFilterMiss | undefined {
  if (campaign.rewards.some((reward) => rewardMatchesFilter(reward, filter))) return undefined;
  const kindHit = campaign.rewards.some((reward) =>
    rewardKinds(reward).some((kind) => filter.kinds.includes(kind)),
  );
  return kindHit ? "subscription" : "kind";
}
