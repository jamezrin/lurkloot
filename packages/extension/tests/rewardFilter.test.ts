import { describe, expect, it } from "vitest";
import type { DropCampaign, DropReward, RewardFilter } from "@lurkloot/shared/models";
import {
  campaignFilterMiss,
  campaignRewardFilter,
  campaignRewardGroup,
  defaultRewardFilter,
  isRewardFilterNarrowed,
  normalizeRewardFilter,
  rewardGroupsDiffer,
  rewardKinds,
  rewardMatchesFilter,
} from "@lurkloot/shared/rewardFilter";
import { mergeEngineSettings } from "@lurkloot/shared/settings";

function reward(patch: Partial<DropReward> = {}): DropReward {
  return {
    id: "r1",
    name: "Reward",
    requiredMinutes: 60,
    watchedMinutes: 0,
    status: "locked",
    ...patch,
  } as DropReward;
}

const filter = (patch: Partial<RewardFilter> = {}): RewardFilter => ({
  kinds: ["item", "badge", "emote"],
  subscriptions: "include",
  pinnedKinds: ["item", "badge", "emote"],
  favouriteKinds: ["item", "badge", "emote"],
  ...patch,
});

describe("reward filter", () => {
  it("reads kinds from every benefit", () => {
    expect(
      rewardKinds({
        benefits: [{ distributionType: "DIRECT_ENTITLEMENT" }, { distributionType: "BADGE" }],
      }),
    ).toEqual(["item", "badge"]);
  });

  it("counts untyped and unknown benefits as items", () => {
    expect(rewardKinds({ benefits: [{}] })).toEqual(["item"]);
    expect(rewardKinds({ benefits: [{ distributionType: "UNKNOWN" }] })).toEqual(["item"]);
    expect(rewardKinds({})).toEqual(["item"]);
  });

  it("falls back to the legacy first-benefit type", () => {
    expect(rewardKinds({ benefitType: "EMOTE" })).toEqual(["emote"]);
  });

  it("matches a mixed reward on any of its kinds", () => {
    const mixed = reward({
      benefits: [{ distributionType: "DIRECT_ENTITLEMENT" }, { distributionType: "BADGE" }],
    });
    expect(rewardMatchesFilter(mixed, filter({ kinds: ["badge"] }))).toBe(true);
  });

  it("applies the subscription mode", () => {
    const sub = reward({ requiredSubs: 1 });
    const free = reward();
    expect(rewardMatchesFilter(sub, filter({ subscriptions: "skip" }))).toBe(false);
    expect(rewardMatchesFilter(free, filter({ subscriptions: "skip" }))).toBe(true);
    expect(rewardMatchesFilter(sub, filter({ subscriptions: "only" }))).toBe(true);
    expect(rewardMatchesFilter(free, filter({ subscriptions: "only" }))).toBe(false);
    expect(rewardMatchesFilter(sub, filter())).toBe(true);
    expect(rewardMatchesFilter(free, filter())).toBe(true);
  });

  it("lets a marked subscription through skip but still counts it under only", () => {
    const marked = reward({ requiredSubs: 1, subscriptionMarked: true });
    expect(rewardMatchesFilter(marked, filter({ subscriptions: "skip" }))).toBe(true);
    expect(rewardMatchesFilter(marked, filter({ subscriptions: "only" }))).toBe(true);
  });

  it("says which question excluded a campaign", () => {
    const campaign = (rewards: DropReward[]): Pick<DropCampaign, "rewards"> => ({ rewards });
    expect(
      campaignFilterMiss(campaign([reward(), reward({ id: "r2" })]), filter({ kinds: ["badge"] })),
    ).toBe("kind");
    expect(
      campaignFilterMiss(
        campaign([reward({ requiredSubs: 1, benefits: [{ distributionType: "BADGE" }] })]),
        filter({ kinds: ["badge"], subscriptions: "skip" }),
      ),
    ).toBe("subscription");
    expect(campaignFilterMiss(campaign([reward()]), filter())).toBeUndefined();
  });

  it("normalizes to what the platform supports", () => {
    expect(normalizeRewardFilter({ kinds: ["badge"] }, "kick")).toEqual({
      kinds: ["item"],
      subscriptions: "include",
      pinnedKinds: ["item"],
      favouriteKinds: ["item"],
    });
    // An empty list farms nothing from its group (#932), and the group lists
    // follow it.
    expect(normalizeRewardFilter({ kinds: [] }, "twitch")).toEqual({
      kinds: [],
      subscriptions: "include",
      pinnedKinds: [],
      favouriteKinds: [],
    });
    expect(normalizeRewardFilter({ kinds: ["item"], favouriteKinds: [] }, "twitch")).toMatchObject({
      kinds: ["item"],
      pinnedKinds: ["item"],
      favouriteKinds: [],
    });
    expect(normalizeRewardFilter("junk", "twitch")).toEqual(defaultRewardFilter("twitch"));
    expect(
      normalizeRewardFilter({ kinds: ["emote", "badge"], subscriptions: "only" }, "twitch"),
    ).toEqual({
      kinds: ["badge", "emote"],
      subscriptions: "only",
      pinnedKinds: ["badge", "emote"],
      favouriteKinds: ["badge", "emote"],
    });
  });

  it("knows when a filter is narrowed", () => {
    expect(isRewardFilterNarrowed(defaultRewardFilter("twitch"), "twitch")).toBe(false);
    expect(
      isRewardFilterNarrowed({ ...defaultRewardFilter("twitch"), subscriptions: "skip" }, "twitch"),
    ).toBe(true);
    const items: RewardFilter = {
      kinds: ["item"],
      subscriptions: "include",
      pinnedKinds: ["item"],
      favouriteKinds: ["item"],
    };
    expect(isRewardFilterNarrowed(items, "twitch")).toBe(true);
    expect(isRewardFilterNarrowed(items, "kick")).toBe(false);
  });
});

// #932: each Queue group (pinned, favourite games, the rest) picks its kinds.
describe("reward kinds per Queue group", () => {
  const campaign = (id: string, categoryId = "game"): DropCampaign =>
    ({
      id,
      platform: "twitch",
      name: id,
      status: "active",
      categoryId,
      gameName: categoryId,
      rewards: [reward()],
    }) as DropCampaign;
  const settings = mergeEngineSettings({
    platform: {
      twitch: {
        campaignPins: ["pinned", "pinned-starred"],
        favouriteCategories: [{ id: "starred", name: "starred" }],
        unlinkedCampaigns: "last",
        rewardFilter: {
          kinds: ["badge"],
          subscriptions: "skip",
          pinnedKinds: ["item"],
          favouriteKinds: ["item", "emote"],
        },
      },
    },
  } as never);

  it("places a campaign in its Queue group, a pin before a star", () => {
    expect(campaignRewardGroup(campaign("pinned"), settings)).toBe("pinned");
    expect(campaignRewardGroup(campaign("pinned-starred", "starred"), settings)).toBe("pinned");
    expect(campaignRewardGroup(campaign("starred", "starred"), settings)).toBe("favourite");
    expect(campaignRewardGroup(campaign("plain"), settings)).toBe("other");
    // Unlinked and farmed last is still one of the rest.
    const unlinked = { ...campaign("unlinked"), accountLinked: false };
    expect(campaignRewardGroup(unlinked, settings)).toBe("other");
  });

  it("judges each campaign by its group's kinds and the shared subscription mode", () => {
    expect(campaignRewardFilter(campaign("pinned"), settings)).toEqual({
      kinds: ["item"],
      subscriptions: "skip",
      pinnedKinds: ["item"],
      favouriteKinds: ["item"],
    });
    expect(campaignRewardFilter(campaign("starred", "starred"), settings).kinds).toEqual([
      "item",
      "emote",
    ]);
    expect(campaignRewardFilter(campaign("plain"), settings).kinds).toEqual(["badge"]);
    // An item reward is farmed for the starred game, not for the rest.
    const item = reward({ benefits: [{ id: "b", distributionType: "DIRECT_ENTITLEMENT" }] });
    const starred = campaignRewardFilter(campaign("starred", "starred"), settings);
    expect(rewardMatchesFilter(item, { ...starred, subscriptions: "include" })).toBe(true);
    expect(
      rewardMatchesFilter(item, {
        ...campaignRewardFilter(campaign("plain"), settings),
        subscriptions: "include",
      }),
    ).toBe(false);
  });

  it("lets a filter saved before the groups follow its kinds in every group", () => {
    const old = normalizeRewardFilter({ kinds: ["badge"], subscriptions: "include" }, "twitch");
    expect(old.pinnedKinds).toEqual(["badge"]);
    expect(old.favouriteKinds).toEqual(["badge"]);
    expect(rewardGroupsDiffer(old, "twitch")).toBe(false);
    // A group list that names nothing the platform has follows kinds too.
    expect(
      normalizeRewardFilter({ kinds: ["item"], pinnedKinds: ["badge"] }, "kick").pinnedKinds,
    ).toEqual(["item"]);
  });

  it("counts a narrowed group as narrowing the filter", () => {
    const pinnedNarrowed = { ...defaultRewardFilter("twitch"), pinnedKinds: ["badge" as const] };
    expect(isRewardFilterNarrowed(pinnedNarrowed, "twitch")).toBe(true);
    expect(rewardGroupsDiffer(pinnedNarrowed, "twitch")).toBe(true);
    // One campaign's filter is narrowed only by its own group.
    const wide = mergeEngineSettings({
      platform: { twitch: { rewardFilter: pinnedNarrowed } },
    } as never);
    expect(isRewardFilterNarrowed(campaignRewardFilter(campaign("plain"), wide), "twitch")).toBe(
      false,
    );
  });
});
