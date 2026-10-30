import type { ActivityEvent } from "@lurkloot/shared/events";
import type { TwitchExtensionProviderId } from "@lurkloot/shared/models";
import type { RewardObtainedData } from "@lurkloot/shared/rewardEvents";
import type { NoPixelOpenedPack } from "./nopixel/driver";

// A reward a Twitch Extension driver obtained, as the driver knows it.
export type DriverReward =
  | ({ type: "pack" } & NoPixelOpenedPack)
  | { type: "giveaway" }
  | { type: "capture"; collectableId: string };

// Every provider reports its rewards as the general listed-reward event, so a
// new provider needs no change in the activity view: a kind without its own
// layout is shown by the generic row.
export function driverRewardEvent(
  provider: TwitchExtensionProviderId,
  channel: string,
  reward: DriverReward,
): Extract<ActivityEvent, { code: "reward_obtained" }> {
  const base = { source: { platform: "twitch" as const, extension: provider }, channel };
  let data: RewardObtainedData;
  switch (reward.type) {
    case "pack":
      data = {
        kind: "extension_pack",
        ...base,
        amount: reward.cardCount,
        details: Object.entries(reward.editions).map(([edition, count]) => ({
          key: `edition_${edition}`,
          value: count,
        })),
      };
      break;
    case "giveaway":
      data = { kind: "extension_giveaway", ...base };
      break;
    case "capture":
      data = { kind: "extension_capture", ...base, itemId: reward.collectableId };
      break;
  }
  return { category: "activity", code: "reward_obtained", level: "info", platform: "twitch", data };
}
