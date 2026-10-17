import { describe, expect, it } from "vitest";
import type { DropCampaign, DropReward } from "@lurkloot/shared/models";
import {
  applySubscriptionMarks,
  campaignHasSubscriptionRewards,
  campaignHasWatchRewards,
  campaignRequiresSubscription,
  isBadgeReward,
  rewardBadgeBenefit,
  rewardRequirementType,
  subscriptionMarkKey,
} from "@lurkloot/shared/rewards";

const reward = (patch: Partial<DropReward>): DropReward => ({
  id: "reward",
  name: "Reward",
  requiredMinutes: 0,
  watchedMinutes: 0,
  status: "locked",
  ...patch,
});

describe("reward requirements", () => {
  it("classifies explicit and legacy rewards", () => {
    expect(
      rewardRequirementType(reward({ requirement: "subscription", requiredMinutes: 60 })),
    ).toBe("subscription");
    expect(rewardRequirementType(reward({ requiredSubs: 1 }))).toBe("subscription");
    expect(rewardRequirementType(reward({ requiredMinutes: 30 }))).toBe("watch");
    expect(rewardRequirementType(reward({ isWatchBased: false }))).toBe("action");
  });

  it("detects both requirement types in a mixed campaign", () => {
    const campaign = {
      rewards: [
        reward({ requirement: "subscription", requiredSubs: 1 }),
        reward({ requirement: "watch", requiredMinutes: 30 }),
      ],
    } as DropCampaign;
    expect(campaignHasSubscriptionRewards(campaign)).toBe(true);
    expect(campaignHasWatchRewards(campaign)).toBe(true);
  });
});

describe("badge rewards (#731)", () => {
  it("recognizes a badge anywhere among a reward's benefits", () => {
    const mixed = reward({
      name: "Float Skin",
      benefits: [
        { id: "skin", name: "Float Skin", distributionType: "DIRECT_ENTITLEMENT" },
        { id: "badge", name: "Supporter Badge", imageUrl: "badge.png", distributionType: "BADGE" },
      ],
      benefitType: "DIRECT_ENTITLEMENT",
    });

    expect(isBadgeReward(mixed)).toBe(true);
    expect(rewardBadgeBenefit(mixed)).toEqual({
      id: "badge",
      name: "Supporter Badge",
      imageUrl: "badge.png",
      distributionType: "BADGE",
    });
  });

  it("never guesses a badge from names, subscriptions or missing types", () => {
    expect(isBadgeReward(reward({ name: "Founder Badge", requiredSubs: 1 }))).toBe(false);
    expect(isBadgeReward(reward({ benefits: [{ id: "x", name: "Sub Badge" }] }))).toBe(false);
    expect(isBadgeReward(reward({ benefits: [{ id: "x", distributionType: "UNKNOWN" }] }))).toBe(
      false,
    );
    expect(isBadgeReward(reward({ benefits: [] }))).toBe(false);
  });

  it("reads a stored campaign's first benefit type until it is refreshed", () => {
    expect(isBadgeReward(reward({ benefitType: "BADGE", name: "Old Badge" }))).toBe(true);
    expect(rewardBadgeBenefit(reward({ benefitType: "BADGE", name: "Old Badge" }))?.name).toBe(
      "Old Badge",
    );
    expect(isBadgeReward(reward({ benefitType: "DIRECT_ENTITLEMENT" }))).toBe(false);
    // Once refreshed, the typed benefits answer, not the first-benefit field.
    expect(
      isBadgeReward(
        reward({ benefitType: "BADGE", benefits: [{ distributionType: "DIRECT_ENTITLEMENT" }] }),
      ),
    ).toBe(false);
  });

  it("keeps a marked reward's subscription requirement for the campaign type", () => {
    const both = reward({ requiredSubs: 1, requiredMinutes: 30, requirement: "subscription" });
    const campaign: DropCampaign = {
      id: "c",
      platform: "twitch",
      name: "Campaign",
      status: "active",
      rewards: [{ ...both, id: "both" }],
    };
    const marked = applySubscriptionMarks(campaign, [subscriptionMarkKey("c", "both")]);
    expect(marked.rewards[0]!.subscriptionMarked).toBe(true);
    // The engine now treats it as a watch reward; the paid requirement stays.
    expect(rewardRequirementType(marked.rewards[0]!)).toBe("watch");
    expect(campaignHasSubscriptionRewards(marked)).toBe(false);
    expect(campaignRequiresSubscription(marked)).toBe(true);
  });
});
