import { describe, expect, it } from "vitest";
import {
  campaignFilterCategories,
  campaignPassesFarmingFilters,
  isCampaignVisible,
} from "@lurkloot/shared/campaignFilters";
import type { CampaignFilterKey, DropCampaign } from "@lurkloot/shared/models";

const ALL_ON: Record<CampaignFilterKey, boolean> = {
  notLinked: true,
  subscription: true,
  upcoming: true,
  expired: true,
  excluded: true,
  finished: true,
};

function campaign(overrides: Partial<DropCampaign> = {}): DropCampaign {
  return {
    id: "campaign",
    platform: "kick",
    name: "Campaign",
    status: "active",
    rewards: [{
      id: "reward",
      name: "Reward",
      requiredMinutes: 30,
      requirement: "watch",
      isWatchBased: true,
      watchedMinutes: 0,
      status: "locked",
    }],
    connectionUrls: [],
    ...overrides,
  } as DropCampaign;
}

describe("campaignPassesFarmingFilters", () => {
  it("rejects an unlinked campaign when the notLinked filter is off", () => {
    const filters = { ...ALL_ON, notLinked: false };
    expect(campaignPassesFarmingFilters(campaign({ accountLinked: false }), filters)).toBe(false);
    expect(campaignPassesFarmingFilters(campaign({ accountLinked: true }), filters)).toBe(true);
  });

  it("ignores the display-only keys, including excluded", () => {
    const filters = { ...ALL_ON, expired: false, finished: false, upcoming: false, excluded: false };
    expect(campaignPassesFarmingFilters(campaign(), filters)).toBe(true);
  });

  it("does not inherit the claimable-reward escape hatch", () => {
    const claimable = campaign({
      accountLinked: false,
      rewards: [{
        id: "reward",
        name: "Reward",
        requiredMinutes: 30,
        requirement: "watch",
        isWatchBased: true,
        watchedMinutes: 30,
        status: "claimable",
      }],
    });
    const filters = { ...ALL_ON, notLinked: false };
    expect(isCampaignVisible(claimable, filters, new Set())).toBe(true);
    expect(campaignPassesFarmingFilters(claimable, filters)).toBe(false);
  });
});

describe("campaignFilterCategories", () => {
  it("tags an excluded campaign", () => {
    expect(campaignFilterCategories(campaign(), new Set(["campaign"]))).toContain("excluded");
  });
});
