import type {
  DropCampaign,
  DropReward,
  EngineSettings,
  Platform,
  RewardFilter,
  RewardFilterMiss,
  RewardKind,
  SubscriptionRewardMode,
} from "./models";
import { campaignRankTier } from "./ranking";
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

// The Queue groups that each choose their reward kinds (#932): pinned
// campaigns, campaigns of a favourite game, and every other campaign.
export type RewardGroup = "pinned" | "favourite" | "other";
export const REWARD_GROUPS: readonly RewardGroup[] = ["pinned", "favourite", "other"];

const GROUP_FIELDS: Record<RewardGroup, "pinnedKinds" | "favouriteKinds" | "kinds"> = {
  pinned: "pinnedKinds",
  favourite: "favouriteKinds",
  other: "kinds",
};

export function rewardGroupKinds(filter: RewardFilter, group: RewardGroup): RewardKind[] {
  return filter[GROUP_FIELDS[group]];
}

export function withRewardGroupKinds(
  filter: RewardFilter,
  group: RewardGroup,
  kinds: RewardKind[],
): RewardFilter {
  return { ...filter, [GROUP_FIELDS[group]]: kinds };
}

export function defaultRewardFilter(platform: Platform): RewardFilter {
  const all = PLATFORM_REWARD_KINDS[platform];
  return {
    kinds: [...all],
    subscriptions: "include",
    pinnedKinds: [...all],
    favouriteKinds: [...all],
  };
}

// A kinds list as stored, in platform order. An empty list farms nothing from
// its group (#932); a list naming only kinds the platform lacks farms every
// kind it has, as it always did; anything that is not a list is undefined, so
// the caller picks its default.
function normalizeKinds(value: unknown, platform: Platform): RewardKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0) return [];
  const supported = PLATFORM_REWARD_KINDS[platform];
  const kinds = REWARD_KINDS.filter((kind) => supported.includes(kind) && value.includes(kind));
  return kinds.length > 0 ? kinds : [...supported];
}

export function normalizeRewardFilter(value: unknown, platform: Platform): RewardFilter {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const kinds = normalizeKinds(record.kinds, platform) ?? [...PLATFORM_REWARD_KINDS[platform]];
  const subscriptions = SUBSCRIPTION_REWARD_MODES.find((mode) => mode === record.subscriptions);
  // A filter saved before the groups existed has no group lists: they follow
  // `kinds`, so nothing farms differently until the user edits a group.
  return {
    kinds,
    subscriptions: subscriptions ?? "include",
    pinnedKinds: normalizeKinds(record.pinnedKinds, platform) ?? [...kinds],
    favouriteKinds: normalizeKinds(record.favouriteKinds, platform) ?? [...kinds],
  };
}

export function isRewardFilterNarrowed(filter: RewardFilter, platform: Platform): boolean {
  const normalized = normalizeRewardFilter(filter, platform);
  const all = PLATFORM_REWARD_KINDS[platform].length;
  return (
    normalized.subscriptions !== "include"
    || REWARD_GROUPS.some((group) => rewardGroupKinds(normalized, group).length < all)
  );
}

// Whether the Queue groups farm different kinds from one another.
export function rewardGroupsDiffer(filter: RewardFilter, platform: Platform): boolean {
  const normalized = normalizeRewardFilter(filter, platform);
  const other = normalized.kinds.join();
  return normalized.pinnedKinds.join() !== other || normalized.favouriteKinds.join() !== other;
}

// The campaign's Queue group, for its reward kinds. A pinned campaign of a
// favourite game is pinned, as in the Queue; an unlinked one farmed last is an
// "other" campaign.
export function campaignRewardGroup(campaign: DropCampaign, settings: EngineSettings): RewardGroup {
  const tier = campaignRankTier(campaign, settings);
  return tier === "pinned" ? "pinned" : tier === "favourite" ? "favourite" : "other";
}

// The filter one campaign is judged by: its group's kinds and the shared
// subscription mode. Every group list holds those same kinds, so whatever
// reads the result (isRewardFilterNarrowed, rewardMatchesFilter) sees exactly
// that campaign's filter.
export function campaignRewardFilter(
  campaign: DropCampaign,
  settings: EngineSettings,
  group: RewardGroup = campaignRewardGroup(campaign, settings),
): RewardFilter {
  const filter = normalizeRewardFilter(
    settings.platform[campaign.platform].rewardFilter,
    campaign.platform,
  );
  const kinds = rewardGroupKinds(filter, group);
  return {
    kinds: [...kinds],
    subscriptions: filter.subscriptions,
    pinnedKinds: [...kinds],
    favouriteKinds: [...kinds],
  };
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
