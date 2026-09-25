import { describe, expect, it } from "vitest";
import {
  campaignEligibleClass,
  campaignFarmable,
  campaignFilterCategories,
  campaignPassesFarmingEligibility,
  campaignSection,
} from "@lurkloot/shared/campaignFilters";
import { mergeSettings } from "@lurkloot/shared/settings";
import type { DropCampaign, EngineSettings, ExtensionSettings, PlatformSettings } from "@lurkloot/shared/models";

const ELIGIBLE_ALL: EngineSettings["farmingEligibility"] = {
  farmUnlinkedCampaigns: true,
  farmSubscriptionCampaigns: true,
};

const FARM_ALL_CATEGORIES: Pick<PlatformSettings, "categoryMode" | "categories"> = {
  categoryMode: "all",
  categories: [],
};


// Builds a full ExtensionSettings so campaignSection/campaignFarmable — which
// both read one settings object — can be exercised with the same terse per-axis
// overrides the old piecemeal-argument tests used.
function settings(overrides: {
  farmingEligibility?: EngineSettings["farmingEligibility"];
  excludedCampaignIds?: string[];
  categorySelection?: Partial<Pick<PlatformSettings, "categoryMode" | "categories" | "blockedCategories">>;
  campaignPins?: string[];
  farmPinnedOnly?: boolean;
} = {}): ExtensionSettings {
  const base = mergeSettings(undefined);
  const categorySelection = overrides.categorySelection ?? FARM_ALL_CATEGORIES;
  return {
    ...base,
    farmingEligibility: overrides.farmingEligibility ?? ELIGIBLE_ALL,
    excludedCampaignIds: overrides.excludedCampaignIds ?? [],
    campaignPins: overrides.campaignPins ?? [],
    farmPinnedOnly: overrides.farmPinnedOnly ?? false,
    platform: {
      twitch: { ...base.platform.twitch, ...categorySelection },
      kick: { ...base.platform.kick, ...categorySelection },
    },
  };
}

function section(campaign: DropCampaign, overrides: Parameters<typeof settings>[0] = {}): string {
  return campaignSection(campaign, settings(overrides));
}

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
    expect(campaignPassesFarmingEligibility(campaign({ eligibility: "account_not_linked" }), off)).toBe(false);
    expect(campaignPassesFarmingEligibility(campaign({ accountLinked: true }), off)).toBe(true);
    expect(campaignPassesFarmingEligibility(campaign({ accountLinked: false }), ELIGIBLE_ALL)).toBe(true);
    expect(campaignPassesFarmingEligibility(campaign({ eligibility: "account_not_linked" }), ELIGIBLE_ALL)).toBe(true);
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

describe("campaignFarmable", () => {
  // The single shared definition consumed by both the scheduler (isEligible)
  // and the popup (isCampaignVisible). These mirror what used to be the private
  // engine-only isEligible tests, now directly testable since the predicate is
  // exported from shared.
  it("is true for an ordinary active campaign with an earnable reward", () => {
    expect(campaignFarmable(campaign(), settings())).toBe(true);
  });

  it("is false once every reward is claimed", () => {
    const c = campaign({ rewards: [{ ...campaign().rewards[0]!, status: "claimed" }] });
    expect(campaignFarmable(c, settings())).toBe(false);
  });

  it("is false for a non-active status", () => {
    expect(campaignFarmable(campaign({ status: "expired" }), settings())).toBe(false);
    expect(campaignFarmable(campaign({ status: "upcoming" }), settings())).toBe(false);
  });

  it("is false for an ended campaign even while status is still active", () => {
    const c = campaign({ endsAt: new Date(Date.now() - 1000).toISOString() });
    expect(campaignFarmable(c, settings())).toBe(false);
  });

  it("is false when eligibility says otherwise", () => {
    expect(campaignFarmable(campaign({ eligibility: "expired" }), settings())).toBe(false);
  });

  it("is false for an excluded campaign", () => {
    const s = settings({ excludedCampaignIds: ["campaign"] });
    expect(campaignFarmable(campaign(), s)).toBe(false);
  });

  it("is false when the class flag turns off unlinked or subscription farming", () => {
    expect(campaignFarmable(campaign({ accountLinked: false }), settings({ farmingEligibility: { ...ELIGIBLE_ALL, farmUnlinkedCampaigns: false } }))).toBe(false);
    expect(campaignFarmable(subscriptionCampaign(), settings({ farmingEligibility: { ...ELIGIBLE_ALL, farmSubscriptionCampaigns: false } }))).toBe(false);
  });

  it("is false outside the selected categories in include mode", () => {
    const c = campaign({ gameName: "Other Game" });
    const s = settings({ categorySelection: { categoryMode: "include", categories: [{ id: "selected-game", name: "Selected Game" }] } });
    expect(campaignFarmable(c, s)).toBe(false);
  });

  it("is true for an unlinked Twitch campaign when farmUnlinkedCampaigns is on", () => {
    const c = campaign({ platform: "twitch", accountLinked: false, eligibility: "account_not_linked" });
    expect(campaignFarmable(c, settings())).toBe(true);
    expect(campaignEligibleClass(c, settings())).toBe(true);
  });

  it("is true for an unlinked Kick campaign (no platform block)", () => {
    const c = campaign({ platform: "kick", accountLinked: false });
    expect(campaignFarmable(c, settings())).toBe(true);
  });

  it("is false when the only reward's precondition is not met", () => {
    const c = campaign({ rewards: [{ ...campaign().rewards[0]!, preconditionsMet: false }] });
    expect(campaignFarmable(c, settings())).toBe(false);
  });

  it("is false when the reward's deadline is infeasible under skipUnfinishableRewards", () => {
    const c = campaign({
      endsAt: new Date(Date.now() + 60_000).toISOString(), // ends in 1 minute
      rewards: [{ ...campaign().rewards[0]!, requiredMinutes: 120, watchedMinutes: 0 }], // needs 2 hours
    });
    expect(campaignFarmable(c, settings())).toBe(false);
  });

  it("is true when skipUnfinishableRewards is off despite an infeasible deadline", () => {
    const c = campaign({
      endsAt: new Date(Date.now() + 60_000).toISOString(),
      rewards: [{ ...campaign().rewards[0]!, requiredMinutes: 120, watchedMinutes: 0 }],
    });
    const s: ExtensionSettings = { ...settings(), skipUnfinishableRewards: false };
    expect(campaignFarmable(c, s)).toBe(true);
  });
});

describe("campaignSection sorts campaigns into the popup's lists", () => {
  const NOT_FARMED_UNLINKED = { ...ELIGIBLE_ALL, farmUnlinkedCampaigns: false };
  const NOT_FARMED_SUBSCRIPTION = { ...ELIGIBLE_ALL, farmSubscriptionCampaigns: false };

  it("queues a farmable campaign", () => {
    expect(section(campaign())).toBe("queue");
  });

  it("skips a campaign whose class is not farmed, rather than hiding it", () => {
    expect(section(campaign({ accountLinked: false }), { farmingEligibility: NOT_FARMED_UNLINKED })).toBe("skipped");
    expect(section(campaign({ eligibility: "account_not_linked" }), { farmingEligibility: NOT_FARMED_UNLINKED })).toBe("skipped");
    expect(section(subscriptionCampaign(), { farmingEligibility: NOT_FARMED_SUBSCRIPTION })).toBe("skipped");
  });

  it("queues a not-linked campaign while that class is farmed", () => {
    expect(section(campaign({ accountLinked: false }), { farmingEligibility: ELIGIBLE_ALL })).toBe("queue");
  });

  it("skips an excluded campaign", () => {
    expect(section(campaign(), { excludedCampaignIds: ["campaign"] })).toBe("skipped");
  });

  it("skips an unpinned campaign while farming only pinned ones", () => {
    expect(section(campaign(), { farmPinnedOnly: true })).toBe("skipped");
    expect(section(campaign(), { farmPinnedOnly: true, campaignPins: ["campaign"] })).toBe("queue");
  });

  it("separates upcoming, expired and completed campaigns from the queue", () => {
    expect(section(campaign({ status: "upcoming" }))).toBe("upcoming");
    expect(section(campaign({ status: "expired" }))).toBe("expired");
    const finished = campaign({
      rewards: [{ id: "reward", name: "Reward", requiredMinutes: 30, requirement: "watch", isWatchBased: true, watchedMinutes: 30, status: "claimed" }],
    });
    expect(section(finished)).toBe("completed");
  });

  it("calls a claimed, past-end campaign completed rather than expired", () => {
    const c = campaign({
      status: "expired",
      endsAt: new Date(Date.now() - 1000).toISOString(),
      rewards: [{ id: "reward", name: "Reward", requiredMinutes: 30, requirement: "watch", isWatchBased: true, watchedMinutes: 30, status: "claimed" }],
    });
    expect(section(c)).toBe("completed");
  });

  it("skips a blocked game in either category mode", () => {
    const blocked = { blockedCategories: [{ id: "rust", name: "Rust" }] };
    const c = campaign({ categoryId: "rust", gameName: "Rust" });
    expect(section(c, { categorySelection: { ...FARM_ALL_CATEGORIES, ...blocked } })).toBe("skipped");
    expect(section(c, {
      categorySelection: { categoryMode: "include", categories: [{ id: "rust", name: "Rust" }], ...blocked },
    })).toBe("skipped");
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

describe("eligibility-driven lifecycle sections", () => {
  // Aligning the popup's sections with the engine's eligibility view: none of
  // these states is farmable (campaignFarmable rejects any eligibility !==
  // "eligible"), so none of them belongs in the queue.
  it("sections an active/upcoming-eligibility campaign as upcoming", () => {
    expect(section(campaign({ status: "active", eligibility: "upcoming" }))).toBe("upcoming");
  });

  it("sections an active/expired-eligibility campaign as expired", () => {
    expect(section(campaign({ status: "active", eligibility: "expired" }))).toBe("expired");
  });

  it("sections an active/completed-eligibility campaign as completed", () => {
    expect(section(campaign({ status: "active", eligibility: "completed" }))).toBe("completed");
  });
});

describe("section invariant: every farmable campaign is queued", () => {
  // This binds the popup's sectioning to the engine's farming rule: anything the
  // engine would farm MUST be in the queue, never tucked into another list. A
  // campaign the engine farms is active, not ended, eligibility "eligible" (or
  // absent), and has an earnable reward — regardless of link status or
  // subscription requirement, since farmUnlinkedCampaigns and
  // farmSubscriptionCampaigns both default to on.
  const farmable: DropCampaign[] = [
    campaign({ eligibility: "eligible" }),
    campaign(),
    campaign({ accountLinked: false }),
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

  it("queues every farmable campaign", () => {
    for (const c of farmable) {
      expect(campaignFarmable(c, settings())).toBe(true);
      expect(section(c)).toBe("queue");
    }
  });
});

describe("campaignSection category selection", () => {
  const selectedOnly: Pick<PlatformSettings, "categoryMode" | "categories"> = {
    categoryMode: "include",
    categories: [{ id: "selected-game", name: "Selected Game" }],
  };
  const blockSelected = {
    categoryMode: "all" as const,
    categories: [],
    blockedCategories: [{ id: "selected-game", name: "Selected Game" }],
  };

  it("skips a campaign outside the selected categories in include mode", () => {
    expect(section(campaign({ gameName: "Other Game" }), { categorySelection: selectedOnly })).toBe("skipped");
  });

  it("queues a campaign in the selected categories", () => {
    expect(section(campaign({ gameName: "Selected Game" }), { categorySelection: selectedOnly })).toBe("queue");
  });

  it("queues every campaign in all mode regardless of the list", () => {
    expect(section(campaign({ gameName: "Other Game" }), { categorySelection: { categoryMode: "all", categories: [] } })).toBe("queue");
  });

  it("skips exactly the blocked categories, and nothing else", () => {
    expect(section(campaign({ gameName: "Selected Game" }), { categorySelection: blockSelected })).toBe("skipped");
    expect(section(campaign({ gameName: "Other Game" }), { categorySelection: blockSelected })).toBe("queue");
  });

  it("matches the engine's farming rule: a category-filtered-out campaign is never farmable either", () => {
    const c = campaign({ gameName: "Other Game" });
    expect(campaignFarmable(c, settings({ categorySelection: selectedOnly }))).toBe(false);
    expect(section(c, { categorySelection: selectedOnly })).toBe("skipped");
  });

  it("keeps a completed campaign in Completed even when its category is not selected", () => {
    const c = campaign({
      gameName: "Other Game",
      rewards: [{ ...campaign().rewards[0]!, status: "claimed" }],
    });
    expect(section(c, { categorySelection: selectedOnly })).toBe("completed");
  });
});

describe("campaignSection keeps reward-timing rejections in Skipped", () => {
  // A campaign whose only reward is momentarily un-farmable for TIMING reasons
  // (deadline infeasible under skipUnfinishableRewards, an unmet precondition on
  // a locked follow-up reward) must NOT vanish from the popup, even though
  // campaignFarmable (and therefore isEligible) correctly refuses to farm it:
  // the user still needs to see it to ease the deadline margin or pin it.
  it("skips — rather than hides — a reward with an infeasible deadline", () => {
    const c = campaign({
      endsAt: new Date(Date.now() + 60_000).toISOString(),
      rewards: [{ ...campaign().rewards[0]!, requiredMinutes: 120, watchedMinutes: 0 }],
    });
    expect(campaignFarmable(c, settings())).toBe(false);
    expect(section(c)).toBe("skipped");
  });

  it("skips a reward whose precondition is not met", () => {
    const c = campaign({ rewards: [{ ...campaign().rewards[0]!, preconditionsMet: false }] });
    expect(campaignFarmable(c, settings())).toBe(false);
    expect(section(c)).toBe("skipped");
  });

  it("queues it again once the reward's timing becomes feasible", () => {
    const c = campaign({ rewards: [{ ...campaign().rewards[0]!, preconditionsMet: true }] });
    expect(campaignFarmable(c, settings())).toBe(true);
    expect(section(c)).toBe("queue");
  });
});
