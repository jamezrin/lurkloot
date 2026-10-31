import type { Platform, TwitchExtensionProviderId } from "./models";

// What a listed reward is. Listed rewards are shown one entry each; a new kind
// is added here and, optionally, given its own popup layout. Without one the
// popup shows it through its generic row.
export type ListedRewardKind =
  | "challenge_card"
  | "extension_capture"
  | "extension_pack"
  | "extension_giveaway";

// What a tallied reward is. Tallied rewards are summed per key per farming
// session instead of being stored one row each.
export type TalliedKind = "channel_points";

export type RewardCountKey = "drop" | ListedRewardKind;

export interface RewardSource {
  platform: Platform;
  extension?: TwitchExtensionProviderId;
}

// A kind-specific extra the generic row can show as a chip, such as a Kick
// challenge's recurrence or a pack's per-edition count.
export interface RewardDetail {
  key: string;
  value: string | number;
}

export interface RewardObtainedData {
  kind: ListedRewardKind;
  source: RewardSource;
  name?: string;
  imageUrl?: string;
  amount?: number;
  rarity?: string;
  channel?: string;
  itemId?: string;
  details?: RewardDetail[];
}

export interface PointsEarnedData {
  channelId: string;
  channelLogin?: string;
  channelDisplayName?: string;
  channelImageUrl?: string;
  // The platform's own reason code (Twitch: WATCH, CLAIM, WATCH_STREAK, RAID,
  // ...), kept as a string so a reason it adds later still shows.
  reason: string;
  amount: number;
}

// Platform responses and vendor state are untrusted: a URL is kept only when it
// is an absolute https URL with no embedded credentials.
export function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && !url.username && !url.password ? trimmed : undefined;
  } catch {
    return undefined;
  }
}
