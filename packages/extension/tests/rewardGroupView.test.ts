import { describe, expect, it } from "vitest";
import type { DropCampaign, WatchSession } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";
import { campaignRejectionMessage } from "../../popup-ui/src/drops";
import type { TFunction } from "../../popup-ui/src/types";
import { campaignViewFromCampaign } from "../../popup-ui/src/viewModels";

const idleSession: WatchSession = { platform: "twitch", offlineChecks: 0, status: "idle" };

const t: TFunction = (key, substitutions) =>
  substitutions === undefined ? key : `${key}(${[substitutions].flat().join("|")})`;

function itemCampaign(id: string, categoryId: string): DropCampaign {
  return {
    id,
    platform: "twitch",
    name: id,
    status: "active",
    categoryId,
    gameName: categoryId,
    accountLinked: true,
    rewards: [
      {
        id: `${id}-reward`,
        name: "Crate",
        requiredMinutes: 60,
        watchedMinutes: 0,
        status: "locked",
        benefits: [{ id: "b", distributionType: "DIRECT_ENTITLEMENT" }],
      },
    ],
  } as DropCampaign;
}

// #932: a card is judged, and its skip worded, by its own Queue group's kinds.
describe("campaign view reward group", () => {
  const settings = mergeSettings({
    platform: {
      twitch: {
        campaignPins: ["pinned"],
        favouriteCategories: [{ id: "starred", name: "starred" }],
        rewardFilter: {
          kinds: ["item", "badge", "emote"],
          subscriptions: "include",
          pinnedKinds: ["badge", "emote"],
          favouriteKinds: ["emote"],
        },
      },
    },
  } as never);
  const view = (campaign: DropCampaign) =>
    campaignViewFromCampaign(campaign, 0, idleSession, false, {
      skipUnfinishableRewards: settings.skipUnfinishableRewards,
      deadlineSafetyMarginMinutes: settings.deadlineSafetyMarginMinutes,
      settings,
    });

  it("carries the filter of the campaign's group", () => {
    expect(view(itemCampaign("pinned", "game")).rewardFilter?.kinds).toEqual(["badge", "emote"]);
    expect(view(itemCampaign("starred", "starred")).rewardFilter?.kinds).toEqual(["emote"]);
    expect(view(itemCampaign("plain", "game")).rewardFilter?.kinds).toEqual([
      "item",
      "badge",
      "emote",
    ]);
  });

  it("names the group's kinds when the filter skips a campaign", () => {
    const pinned = view(itemCampaign("pinned", "game"));
    expect(pinned.farmingRejection?.code).toBe("reward_type_filtered");
    expect(campaignRejectionMessage(pinned.farmingRejection!, pinned.rewardFilter!, t, "en")).toBe(
      "campaignRejectionRewardKind(rewardKindBadge or rewardKindEmote)",
    );
    // The rest farm items, so the same reward is not skipped there.
    expect(view(itemCampaign("plain", "game")).farmingRejection).toBeUndefined();
  });

  it("names the pinned kinds for an unpinned campaign while only pins are farmed", () => {
    const pinnedOnly = mergeSettings({
      platform: {
        twitch: {
          // Only pins farm (#932): the other groups farm no kinds.
          rewardFilter: {
            kinds: [],
            subscriptions: "include",
            pinnedKinds: ["badge"],
            favouriteKinds: [],
          },
        },
      },
    } as never);
    const plain = campaignViewFromCampaign(itemCampaign("plain", "game"), 0, idleSession, false, {
      skipUnfinishableRewards: pinnedOnly.skipUnfinishableRewards,
      deadlineSafetyMarginMinutes: pinnedOnly.deadlineSafetyMarginMinutes,
      settings: pinnedOnly,
    });
    // A pin would judge it by badges, which its item reward misses.
    expect(plain.farmingRejection?.code).toBe("reward_type_filtered");
    expect(campaignRejectionMessage(plain.farmingRejection!, plain.rewardFilter!, t, "en")).toBe(
      "campaignRejectionRewardKind(rewardKindBadge)",
    );
  });

  it("says its group farms nothing when even a pin would not farm it", () => {
    const nothingPinned = mergeSettings({
      platform: {
        twitch: {
          rewardFilter: {
            kinds: [],
            subscriptions: "include",
            pinnedKinds: [],
            favouriteKinds: ["item"],
          },
        },
      },
    } as never);
    const plain = campaignViewFromCampaign(itemCampaign("plain", "game"), 0, idleSession, false, {
      skipUnfinishableRewards: nothingPinned.skipUnfinishableRewards,
      deadlineSafetyMarginMinutes: nothingPinned.deadlineSafetyMarginMinutes,
      settings: nothingPinned,
    });
    expect(plain.farmingRejection?.code).toBe("reward_type_filtered");
    expect(campaignRejectionMessage(plain.farmingRejection!, plain.rewardFilter!, t, "en")).toBe(
      "campaignRejectionGroupOff",
    );
  });
});
