import { describe, expect, it } from "vitest";
import {
  campaignFilterCategories,
  campaignPassesFarmingEligibility,
  isCampaignVisible,
} from "@lurkloot/shared/campaignFilters";
import type { DropCampaign, EngineSettings, ExtensionSettings } from "@lurkloot/shared/models";

const ELIGIBLE_ALL: EngineSettings["farmingEligibility"] = {
  farmUnlinkedCampaigns: true,
  farmSubscriptionCampaigns: true,
};

const SHOW_ALL: ExtensionSettings["dropsListFilter"] = {
  showUpcoming: true,
  showExpired: true,
  showFinished: true,
  showExcluded: true,
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

// A campaign that requires a subscription (mixed subscription/watch).
function subscriptionCampaign(overrides: Partial<DropCampaign> = {}): DropCampaign {
  return campaign({
    rewards: [{
      id: "sub",
      name: "Subscriber reward",
      requiredMinutes: 0,
      requirement: "subscription",
      requiredSubs: 1,
      watchedMinutes: 0,
      status: "locked",
    }],
    ...overrides,
  });
}

describe("campaignPassesFarmingEligibility", () => {
  it("skips an unlinked campaign only when farmUnlinkedCampaigns is off", () => {
    const off = { ...ELIGIBLE_ALL, farmUnlinkedCampaigns: false };
    expect(campaignPassesFarmingEligibility(campaign({ accountLinked: false }), off)).toBe(false);
    expect(campaignPassesFarmingEligibility(campaign({ accountLinked: true }), off)).toBe(true);
    expect(campaignPassesFarmingEligibility(campaign({ accountLinked: false }), ELIGIBLE_ALL)).toBe(true);
  });

  it("skips a subscription campaign only when farmSubscriptionCampaigns is off", () => {
    const off = { ...ELIGIBLE_ALL, farmSubscriptionCampaigns: false };
    expect(campaignPassesFarmingEligibility(subscriptionCampaign(), off)).toBe(false);
    expect(campaignPassesFarmingEligibility(subscriptionCampaign(), ELIGIBLE_ALL)).toBe(true);
  });

  it("passes an ordinary campaign regardless of display flags", () => {
    expect(campaignPassesFarmingEligibility(campaign(), ELIGIBLE_ALL)).toBe(true);
  });
});

describe("isCampaignVisible decoupled from farming eligibility", () => {
  // The coupling regression: a subscription campaign the user has chosen NOT to
  // farm is STILL visible in the Drops list. isCampaignVisible never consults
  // link status or subscription — only lifecycle/excluded and the claimable
  // escape hatch.
  it("still shows a subscription campaign that fails farming eligibility", () => {
    const off = { ...ELIGIBLE_ALL, farmSubscriptionCampaigns: false };
    const c = subscriptionCampaign();
    expect(campaignPassesFarmingEligibility(c, off)).toBe(false);
    expect(isCampaignVisible(c, SHOW_ALL, new Set())).toBe(true);
  });

  it("still shows an unlinked campaign that fails farming eligibility", () => {
    const off = { ...ELIGIBLE_ALL, farmUnlinkedCampaigns: false };
    const c = campaign({ accountLinked: false });
    expect(campaignPassesFarmingEligibility(c, off)).toBe(false);
    expect(isCampaignVisible(c, SHOW_ALL, new Set())).toBe(true);
  });
});

describe("isCampaignVisible display flags", () => {
  it("hides upcoming campaigns unless showUpcoming is on", () => {
    const c = campaign({ status: "upcoming" });
    expect(isCampaignVisible(c, { ...SHOW_ALL, showUpcoming: false }, new Set())).toBe(false);
    expect(isCampaignVisible(c, { ...SHOW_ALL, showUpcoming: true }, new Set())).toBe(true);
  });

  it("hides expired campaigns unless showExpired is on", () => {
    const c = campaign({ status: "expired" });
    expect(isCampaignVisible(c, { ...SHOW_ALL, showExpired: false }, new Set())).toBe(false);
    expect(isCampaignVisible(c, { ...SHOW_ALL, showExpired: true }, new Set())).toBe(true);
  });

  it("hides finished campaigns unless showFinished is on", () => {
    const c = campaign({
      rewards: [{
        id: "reward",
        name: "Reward",
        requiredMinutes: 30,
        requirement: "watch",
        isWatchBased: true,
        watchedMinutes: 30,
        status: "claimed",
      }],
    });
    expect(isCampaignVisible(c, { ...SHOW_ALL, showFinished: false }, new Set())).toBe(false);
    expect(isCampaignVisible(c, { ...SHOW_ALL, showFinished: true }, new Set())).toBe(true);
  });

  it("hides excluded campaigns unless showExcluded is on", () => {
    const c = campaign();
    expect(isCampaignVisible(c, { ...SHOW_ALL, showExcluded: false }, new Set(["campaign"]))).toBe(false);
    expect(isCampaignVisible(c, { ...SHOW_ALL, showExcluded: true }, new Set(["campaign"]))).toBe(true);
  });

  it("finished wins over expired precedence", () => {
    // A claimed, past-end campaign is finished, not expired: showFinished governs.
    const c = campaign({
      status: "expired",
      endsAt: new Date(Date.now() - 1000).toISOString(),
      rewards: [{
        id: "reward",
        name: "Reward",
        requiredMinutes: 30,
        requirement: "watch",
        isWatchBased: true,
        watchedMinutes: 30,
        status: "claimed",
      }],
    });
    expect(isCampaignVisible(c, { ...SHOW_ALL, showFinished: false, showExpired: true }, new Set())).toBe(false);
  });

  it("keeps the claimable escape hatch even when every display flag is off", () => {
    const c = campaign({
      status: "expired",
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
    const allOff = { showUpcoming: false, showExpired: false, showFinished: false, showExcluded: false };
    expect(isCampaignVisible(c, allOff, new Set(["campaign"]))).toBe(true);
  });
});

describe("campaignFilterCategories", () => {
  it("tags an excluded campaign", () => {
    expect(campaignFilterCategories(campaign(), new Set(["campaign"]))).toContain("excluded");
  });

  it("treats an active campaign with an upcoming eligibility as upcoming", () => {
    // The engine categorises by eligibility, not just status; the display must
    // agree or a showUpcoming: false filter leaks a campaign the engine hides.
    const c = campaign({ status: "active", eligibility: "upcoming" });
    expect(campaignFilterCategories(c, new Set())).toContain("upcoming");
  });

  it("treats an active campaign with an expired eligibility as expired", () => {
    const c = campaign({ status: "active", eligibility: "expired" });
    expect(campaignFilterCategories(c, new Set())).toContain("expired");
  });

  it("treats an active campaign with a completed eligibility as finished", () => {
    const c = campaign({ status: "active", eligibility: "completed" });
    expect(campaignFilterCategories(c, new Set())).toContain("finished");
  });
});

describe("eligibility-driven lifecycle hides in the Drops list", () => {
  // Aligning display with the engine's eligibility view: none of these states is
  // farmable (isEligible rejects any eligibility !== "eligible"), so hiding them
  // cannot hide a farmable campaign.
  const allOff = { showUpcoming: false, showExpired: false, showFinished: false, showExcluded: false };

  it("hides an active/upcoming-eligibility campaign when showUpcoming is off", () => {
    const c = campaign({ status: "active", eligibility: "upcoming" });
    expect(isCampaignVisible(c, allOff, new Set())).toBe(false);
    expect(isCampaignVisible(c, { ...allOff, showUpcoming: true }, new Set())).toBe(true);
  });

  it("hides an active/expired-eligibility campaign when showExpired is off", () => {
    const c = campaign({ status: "active", eligibility: "expired" });
    expect(isCampaignVisible(c, allOff, new Set())).toBe(false);
    expect(isCampaignVisible(c, { ...allOff, showExpired: true }, new Set())).toBe(true);
  });

  it("hides an active/completed-eligibility campaign when showFinished is off", () => {
    const c = campaign({ status: "active", eligibility: "completed" });
    expect(isCampaignVisible(c, allOff, new Set())).toBe(false);
    expect(isCampaignVisible(c, { ...allOff, showFinished: true }, new Set())).toBe(true);
  });
});

describe("visibility invariant: every farmable campaign stays visible", () => {
  // This binds the popup's visibility predicate to the engine's farming rule:
  // anything the engine would farm MUST remain visible with every display flag
  // off. A campaign the engine farms is active, not ended, eligibility
  // "eligible" (or absent), and has an earnable reward — regardless of link
  // status or subscription requirement, since farmUnlinkedCampaigns and
  // farmSubscriptionCampaigns both default to on. isCampaignVisible only ever
  // hides the non-farmable lifecycle/excluded states, so it must return true for
  // all of these. If a future change makes a farmable campaign hideable, this
  // fails.
  const allOff = { showUpcoming: false, showExpired: false, showFinished: false, showExcluded: false };

  // The kind of campaign the engine actually farms: active, eligible, with an
  // unclaimed watch reward that still has minutes to earn.
  const farmable: DropCampaign[] = [
    // Ordinary active campaign.
    campaign({ eligibility: "eligible" }),
    // Active campaign, eligibility left absent (also farmed).
    campaign(),
    // Unlinked campaign — still farmed because farmUnlinkedCampaigns defaults on.
    campaign({ accountLinked: false }),
    // Subscription-gated campaign — still farmed because farmSubscriptionCampaigns
    // defaults on and it carries an earnable watch reward.
    subscriptionCampaign({
      rewards: [{
        id: "watch",
        name: "Watch reward",
        requiredMinutes: 30,
        requirement: "watch",
        isWatchBased: true,
        watchedMinutes: 0,
        status: "locked",
      }],
    }),
  ];

  it("keeps every farmable campaign visible with all display flags off", () => {
    for (const c of farmable) {
      // The engine's farming-eligibility gate passes with defaults on.
      expect(campaignPassesFarmingEligibility(c, ELIGIBLE_ALL)).toBe(true);
      expect(isCampaignVisible(c, allOff, new Set())).toBe(true);
    }
  });
});
