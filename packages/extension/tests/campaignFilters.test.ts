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
  showNotLinked: true,
  showSubscription: true,
};

// Every display flag off — including the two class flags — so any campaign that
// stays visible does so because farming forces it, not because a flag is on.
const ALL_OFF: ExtensionSettings["dropsListFilter"] = {
  showUpcoming: false,
  showExpired: false,
  showFinished: false,
  showExcluded: false,
  showNotLinked: false,
  showSubscription: false,
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

describe("isCampaignVisible not-linked / subscription class flags", () => {
  // These two classes obey farming-on OR show-flag-on: the display flag can hide
  // a campaign ONLY when the user is also not farming that class. Farming-on
  // always forces visibility (the invariant), so the flag is a free toggle only
  // for a class you have already opted out of farming.
  const NOT_FARMED_UNLINKED = { ...ELIGIBLE_ALL, farmUnlinkedCampaigns: false };
  const NOT_FARMED_SUBSCRIPTION = { ...ELIGIBLE_ALL, farmSubscriptionCampaigns: false };

  it("hides a not-linked campaign only when it is not farmed and showNotLinked is off", () => {
    const c = campaign({ accountLinked: false });
    // Not farmed + hidden → gone.
    expect(isCampaignVisible(c, { ...SHOW_ALL, showNotLinked: false }, NOT_FARMED_UNLINKED, new Set())).toBe(false);
    // Not farmed + shown → visible.
    expect(isCampaignVisible(c, { ...SHOW_ALL, showNotLinked: true }, NOT_FARMED_UNLINKED, new Set())).toBe(true);
  });

  it("keeps a farmed not-linked campaign visible even with showNotLinked off (invariant)", () => {
    const c = campaign({ accountLinked: false });
    // Farming this class forces visibility regardless of the display flag.
    expect(campaignPassesFarmingEligibility(c, ELIGIBLE_ALL)).toBe(true);
    expect(isCampaignVisible(c, { ...SHOW_ALL, showNotLinked: false }, ELIGIBLE_ALL, new Set())).toBe(true);
  });

  it("hides a subscription campaign only when it is not farmed and showSubscription is off", () => {
    const c = subscriptionCampaign();
    expect(isCampaignVisible(c, { ...SHOW_ALL, showSubscription: false }, NOT_FARMED_SUBSCRIPTION, new Set())).toBe(false);
    expect(isCampaignVisible(c, { ...SHOW_ALL, showSubscription: true }, NOT_FARMED_SUBSCRIPTION, new Set())).toBe(true);
  });

  it("keeps a farmed subscription campaign visible even with showSubscription off (invariant)", () => {
    const c = subscriptionCampaign();
    expect(campaignPassesFarmingEligibility(c, ELIGIBLE_ALL)).toBe(true);
    expect(isCampaignVisible(c, { ...SHOW_ALL, showSubscription: false }, ELIGIBLE_ALL, new Set())).toBe(true);
  });
});

describe("isCampaignVisible display flags", () => {
  it("hides upcoming campaigns unless showUpcoming is on", () => {
    const c = campaign({ status: "upcoming" });
    expect(isCampaignVisible(c, { ...SHOW_ALL, showUpcoming: false }, ELIGIBLE_ALL, new Set())).toBe(false);
    expect(isCampaignVisible(c, { ...SHOW_ALL, showUpcoming: true }, ELIGIBLE_ALL, new Set())).toBe(true);
  });

  it("hides expired campaigns unless showExpired is on", () => {
    const c = campaign({ status: "expired" });
    expect(isCampaignVisible(c, { ...SHOW_ALL, showExpired: false }, ELIGIBLE_ALL, new Set())).toBe(false);
    expect(isCampaignVisible(c, { ...SHOW_ALL, showExpired: true }, ELIGIBLE_ALL, new Set())).toBe(true);
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
    expect(isCampaignVisible(c, { ...SHOW_ALL, showFinished: false }, ELIGIBLE_ALL, new Set())).toBe(false);
    expect(isCampaignVisible(c, { ...SHOW_ALL, showFinished: true }, ELIGIBLE_ALL, new Set())).toBe(true);
  });

  it("hides excluded campaigns unless showExcluded is on", () => {
    const c = campaign();
    expect(isCampaignVisible(c, { ...SHOW_ALL, showExcluded: false }, ELIGIBLE_ALL, new Set(["campaign"]))).toBe(false);
    expect(isCampaignVisible(c, { ...SHOW_ALL, showExcluded: true }, ELIGIBLE_ALL, new Set(["campaign"]))).toBe(true);
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
    expect(isCampaignVisible(c, { ...SHOW_ALL, showFinished: false, showExpired: true }, ELIGIBLE_ALL, new Set())).toBe(false);
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
    const allOff = ALL_OFF;
    expect(isCampaignVisible(c, allOff, ELIGIBLE_ALL, new Set(["campaign"]))).toBe(true);
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
  const allOff = ALL_OFF;

  it("hides an active/upcoming-eligibility campaign when showUpcoming is off", () => {
    const c = campaign({ status: "active", eligibility: "upcoming" });
    expect(isCampaignVisible(c, allOff, ELIGIBLE_ALL, new Set())).toBe(false);
    expect(isCampaignVisible(c, { ...allOff, showUpcoming: true }, ELIGIBLE_ALL, new Set())).toBe(true);
  });

  it("hides an active/expired-eligibility campaign when showExpired is off", () => {
    const c = campaign({ status: "active", eligibility: "expired" });
    expect(isCampaignVisible(c, allOff, ELIGIBLE_ALL, new Set())).toBe(false);
    expect(isCampaignVisible(c, { ...allOff, showExpired: true }, ELIGIBLE_ALL, new Set())).toBe(true);
  });

  it("hides an active/completed-eligibility campaign when showFinished is off", () => {
    const c = campaign({ status: "active", eligibility: "completed" });
    expect(isCampaignVisible(c, allOff, ELIGIBLE_ALL, new Set())).toBe(false);
    expect(isCampaignVisible(c, { ...allOff, showFinished: true }, ELIGIBLE_ALL, new Set())).toBe(true);
  });
});

describe("visibility invariant: every farmable campaign stays visible", () => {
  // This binds the popup's visibility predicate to the engine's farming rule:
  // anything the engine would farm MUST remain visible with every display flag
  // off. A campaign the engine farms is active, not ended, eligibility
  // "eligible" (or absent), and has an earnable reward — regardless of link
  // status or subscription requirement, since farmUnlinkedCampaigns and
  // farmSubscriptionCampaigns both default to on. ALL_OFF turns off every
  // display flag INCLUDING showNotLinked/showSubscription, so the not-linked and
  // subscription cases here specifically prove that farming-on overrides the
  // class show-flags: the four lifecycle/excluded states are non-farmable, and
  // the two class states are held visible by the farming-on branch. It must
  // return true for all of these. If a future change makes a farmable campaign
  // hideable, this fails.
  const allOff = ALL_OFF;

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
      expect(isCampaignVisible(c, allOff, ELIGIBLE_ALL, new Set())).toBe(true);
    }
  });
});
