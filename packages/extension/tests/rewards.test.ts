import { describe, expect, it } from "vitest";
import type { DropCampaign, DropReward } from "@lurkloot/shared/models";
import {
  campaignHasSubscriptionRewards,
  campaignHasWatchRewards,
  rewardRequirementType,
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
    expect(rewardRequirementType(reward({ requirement: "subscription", requiredMinutes: 60 }))).toBe("subscription");
    expect(rewardRequirementType(reward({ requiredSubs: 1 }))).toBe("subscription");
    expect(rewardRequirementType(reward({ requiredMinutes: 30 }))).toBe("watch");
    expect(rewardRequirementType(reward({ isWatchBased: false }))).toBe("action");
  });

  it("detects both requirement types in a mixed campaign", () => {
    const campaign = {
      rewards: [reward({ requirement: "subscription", requiredSubs: 1 }), reward({ requirement: "watch", requiredMinutes: 30 })],
    } as DropCampaign;
    expect(campaignHasSubscriptionRewards(campaign)).toBe(true);
    expect(campaignHasWatchRewards(campaign)).toBe(true);
  });
});
