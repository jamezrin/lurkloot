import { describe, expect, it } from "vitest";
import type { DropCampaign, DropReward, RewardFilter } from "@lurkloot/shared/models";
import {
  campaignFilterMiss,
  defaultRewardFilter,
  isRewardFilterNarrowed,
  normalizeRewardFilter,
  rewardKinds,
  rewardMatchesFilter,
} from "@lurkloot/shared/rewardFilter";

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
    });
    expect(normalizeRewardFilter({ kinds: [] }, "twitch")).toEqual(defaultRewardFilter("twitch"));
    expect(normalizeRewardFilter("junk", "twitch")).toEqual(defaultRewardFilter("twitch"));
    expect(
      normalizeRewardFilter({ kinds: ["emote", "badge"], subscriptions: "only" }, "twitch"),
    ).toEqual({ kinds: ["badge", "emote"], subscriptions: "only" });
  });

  it("knows when a filter is narrowed", () => {
    expect(isRewardFilterNarrowed(defaultRewardFilter("twitch"), "twitch")).toBe(false);
    expect(
      isRewardFilterNarrowed({ ...defaultRewardFilter("twitch"), subscriptions: "skip" }, "twitch"),
    ).toBe(true);
    const items: RewardFilter = { kinds: ["item"], subscriptions: "include" };
    expect(isRewardFilterNarrowed(items, "twitch")).toBe(true);
    expect(isRewardFilterNarrowed(items, "kick")).toBe(false);
  });
});
