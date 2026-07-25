import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelCandidate, DropCampaign, DropReward, ExtensionSettings, KickPlatformSettings, Platform, SchedulerState, TwitchPlatformSettings } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { NO_CATEGORY_ID } from "@lurkloot/shared/categories";
import { chooseCampaignDecision, runSchedulerTick, sortCampaigns } from "@lurkloot/core/scheduler";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import { forgetManagedPageContextTabs, managedTabBreakerOpen, syncManagedTabBreakers } from "@lurkloot/core/tabs";
import { SafeFetchError } from "@lurkloot/core/fetchError";
import { DEFAULT_CRITICAL_HEALTH } from "@lurkloot/shared/criticalHealth";
import { TAB_CHURN_LIMIT, TAB_CHURN_WINDOW_MS } from "@lurkloot/core/criticalHealth";

const reward = (status: DropReward["status"] = "in_progress"): DropReward => ({
  id: `reward-${status}`,
  name: "Reward",
  requiredMinutes: 60,
  watchedMinutes: status === "locked" ? 0 : 20,
  status,
});

const campaign = (id: string, patch: Partial<DropCampaign> = {}): DropCampaign => ({
  id,
  platform: "twitch",
  name: id,
  status: "active",
  rewards: [reward()],
  endsAt: "2099-01-01T00:00:00.000Z",
  ...patch,
});

const channel = (username: string, patch: Partial<ChannelCandidate> = {}): ChannelCandidate => ({
  platform: "twitch",
  username,
  displayName: username,
  url: `https://www.twitch.tv/${username}`,
  ...patch,
});

type SettingsPatch = Partial<Omit<ExtensionSettings, "platform">> & {
  platform?: { twitch?: Partial<TwitchPlatformSettings>; kick?: Partial<KickPlatformSettings> };
};

function settings(patch: SettingsPatch = {}): ExtensionSettings {
  return {
    ...DEFAULT_SETTINGS,
    running: true,
    ...patch,
    platform: {
      twitch: { ...DEFAULT_SETTINGS.platform.twitch, ...patch.platform?.twitch },
      kick: { ...DEFAULT_SETTINGS.platform.kick, ...patch.platform?.kick },
    },
  };
}

function adapter(platform: Platform, campaigns: DropCampaign[], candidates: ChannelCandidate[]): PlatformAdapter {
  return {
    platform,
    checkAuthHealth: vi.fn(async () => ({ status: "checking" as const })),
    discoverCampaigns: vi.fn(async () => campaigns),
    readProgress: vi.fn(async (value) => value),
    listCandidateChannels: vi.fn(async () => candidates),
    checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
    claimReward: vi.fn(async () => true),
    prepareWatchTab: vi.fn(async () => ({ tabId: 42, managedByExtension: true })),
    stopWatchTab: vi.fn(async () => undefined),
  };
}

const HEALTHY_AUTH: SchedulerState["authHealth"] = {
  twitch: { status: "healthy" },
  kick: { status: "healthy" },
};

describe("scheduler campaign selection", () => {
  it("skips an infeasible in-progress reward for a feasible locked reward", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-19T12:00:00.000Z");
    try {
      const inProgress = { ...reward("in_progress"), id: "long", requiredMinutes: 60, watchedMinutes: 10 };
      const locked = { ...reward("locked"), id: "short", requiredMinutes: 20, watchedMinutes: 0 };
      const decision = await chooseCampaignDecision(
        "twitch",
        [campaign("timed", { endsAt: "2026-07-19T12:40:00.000Z", rewards: [inProgress, locked] })],
        settings({ deadlineSafetyMarginMinutes: 5 }),
        {
          listCandidateChannels: vi.fn(async () => [channel("creator")]),
          checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
        },
      );
      expect(decision.action).toBe("watch");
      expect(decision.reward?.id).toBe("short");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a campaign when no watch reward can finish before its deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-19T12:00:00.000Z");
    try {
      const listCandidateChannels = vi.fn(async () => [channel("creator")]);
      const decision = await chooseCampaignDecision(
        "twitch",
        [campaign("timed", { endsAt: "2026-07-19T12:44:59.999Z" })],
        settings({ deadlineSafetyMarginMinutes: 5 }),
        {
          listCandidateChannels,
          checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
        },
      );
      expect(decision.action).toBe("idle");
      expect(decision.reason).toContain("cannot be completed before their deadline");
      expect(listCandidateChannels).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves current selection behavior when deadline filtering is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-19T12:00:00.000Z");
    try {
      const decision = await chooseCampaignDecision(
        "twitch",
        [campaign("timed", { endsAt: "2026-07-19T12:01:00.000Z" })],
        settings({ skipUnfinishableRewards: false, deadlineSafetyMarginMinutes: 5 }),
        {
          listCandidateChannels: vi.fn(async () => [channel("creator")]),
          checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
        },
      );
      expect(decision.action).toBe("watch");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses explicit priority before ending soonest", () => {
    const first = campaign("first", { endsAt: "2026-06-01T00:00:00.000Z" });
    const second = campaign("second", { endsAt: "2026-07-01T00:00:00.000Z" });

    const sorted = sortCampaigns([first, second], settings({
      campaignPriorities: { second: 5 },
    }));

    expect(sorted.map((item) => item.id)).toEqual(["second", "first"]);
  });

  it("uses category-list order after explicit campaign priority", () => {
    const first = campaign("first", { gameName: "First Game", endsAt: "2026-06-01T00:00:00.000Z" });
    const second = campaign("second", { gameName: "Second Game", endsAt: "2026-07-01T00:00:00.000Z" });

    const sorted = sortCampaigns([first, second], settings({
      platform: {
        twitch: { farmAllCategories: false, categories: [{ id: "second game", name: "Second Game" }, { id: "first game", name: "First Game" }] },
      },
    }));

    expect(sorted.map((item) => item.id)).toEqual(["second", "first"]);
  });

  it("does not use category-list order while Farm all categories is on", () => {
    const first = campaign("first", { gameName: "First Game", endsAt: "2026-06-01T00:00:00.000Z" });
    const second = campaign("second", { gameName: "Second Game", endsAt: "2026-07-01T00:00:00.000Z" });

    // farmAllCategories stays on (default), so the list is inert: ends-soonest wins.
    const sorted = sortCampaigns([second, first], settings({}));

    expect(sorted.map((item) => item.id)).toEqual(["first", "second"]);
  });

  it("category filter farms only listed categories and skips the rest", async () => {
    const listed = campaign("listed", { gameName: "Listed Game" });
    const unlisted = campaign("unlisted", { gameName: "Unlisted Game" });

    const decision = await chooseCampaignDecision(
      "twitch",
      [unlisted, listed],
      settings({
        platform: {
          twitch: { farmAllCategories: false, categories: [{ id: "listed game", name: "Listed Game" }] },
        },
      }),
      {
        listCandidateChannels: vi.fn(async () => [channel("creator")]),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("watch");
    expect(decision.campaign?.id).toBe("listed");
  });

  it("the No category selection farms only category-less drops and skips categorized ones", async () => {
    const categorized = campaign("categorized", { gameName: "Rust", categoryId: "13" });
    const uncategorized = campaign("uncategorized"); // no gameName, no categoryId

    const decision = await chooseCampaignDecision(
      "twitch",
      [categorized, uncategorized],
      settings({
        platform: {
          twitch: { farmAllCategories: false, categories: [{ id: NO_CATEGORY_ID, name: "No category" }] },
        },
      }),
      {
        listCandidateChannels: vi.fn(async () => [channel("creator")]),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("watch");
    expect(decision.campaign?.id).toBe("uncategorized");
  });

  it("category filter with an empty list farms nothing", async () => {
    const listCandidateChannels = vi.fn(async () => [channel("creator")]);

    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("any", { gameName: "Any Game" })],
      settings({ platform: { twitch: { farmAllCategories: false, categories: [] } } }),
      {
        listCandidateChannels,
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("idle");
    expect(decision.reason).toContain("No campaigns match the categories filter");
    expect(listCandidateChannels).not.toHaveBeenCalled();
  });

  it("priority list only skips campaigns the user has not reordered", async () => {
    const listCandidateChannels = vi.fn(async () => [channel("creator")]);

    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("unlisted", { gameName: "Unlisted Game" })],
      settings({ priorityMode: "priority_list_only" }),
      {
        listCandidateChannels,
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("idle");
    expect(decision.reason).toContain("No prioritized campaigns are eligible");
    expect(listCandidateChannels).not.toHaveBeenCalled();
  });

  it("priority list only ignores the category list (decoupled)", async () => {
    const listCandidateChannels = vi.fn(async () => [channel("creator")]);

    // A campaign whose category is allowed but which was never manually reordered
    // is NOT farmed under priority_list_only — the two are independent now.
    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("listed", { gameName: "Listed Game" })],
      settings({
        priorityMode: "priority_list_only",
        platform: {
          twitch: { farmAllCategories: false, categories: [{ id: "listed game", name: "Listed Game" }] },
        },
      }),
      {
        listCandidateChannels,
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("idle");
    expect(listCandidateChannels).not.toHaveBeenCalled();
  });

  it("priority list only farms a campaign present in campaignPriorities", async () => {
    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("pinned"), campaign("unlisted")],
      settings({ priorityMode: "priority_list_only", campaignPriorities: { pinned: 5 } }),
      {
        listCandidateChannels: vi.fn(async () => [channel("creator")]),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("watch");
    expect(decision.campaign?.id).toBe("pinned");
  });

  it("does not select campaigns whose only unclaimed reward is outside its earn and claim windows", async () => {
    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("expired-reward", {
        rewards: [{
          ...reward("claimable"),
          claimUntil: "2020-01-01T00:00:00.000Z",
          availableUntil: "2020-01-01T00:00:00.000Z",
        }],
      })],
      settings(),
      {
        listCandidateChannels: vi.fn(async () => [channel("creator")]),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("idle");
  });

  it("does not select an active campaign whose end date has already passed", async () => {
    const listCandidateChannels = vi.fn(async () => [channel("creator")]);

    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("ended", { status: "active", endsAt: "2020-01-01T00:00:00.000Z" })],
      settings(),
      {
        listCandidateChannels,
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("idle");
    expect(listCandidateChannels).not.toHaveBeenCalled();
  });

  it("does not watch campaigns whose only unclaimed rewards are already claimable", async () => {
    const listCandidateChannels = vi.fn(async () => [channel("creator")]);

    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("claim-only", { rewards: [reward("claimable")] })],
      settings(),
      {
        listCandidateChannels,
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("idle");
    expect(listCandidateChannels).not.toHaveBeenCalled();
  });

  it("skips an unlinked Twitch campaign but still farms an unlinked Kick campaign", async () => {
    const checkChannel = vi.fn(async (candidate: ChannelCandidate) => ({ live: true, categoryMatches: true, candidate }));

    // Twitch cannot earn without a linked account → not selected.
    const twitch = await chooseCampaignDecision(
      "twitch",
      [campaign("tw", { accountLinked: false })],
      settings(),
      { listCandidateChannels: vi.fn(async () => [channel("creator")]), checkChannel },
    );
    expect(twitch.action).toBe("idle");

    // Kick accrues progress before linking, so an unlinked campaign is still farmed.
    const kick = await chooseCampaignDecision(
      "kick",
      [campaign("kk", { platform: "kick", accountLinked: false })],
      settings(),
      {
        listCandidateChannels: vi.fn(async () => [channel("creator", { platform: "kick", url: "https://kick.com/creator" })]),
        checkChannel,
      },
    );
    expect(kick.action).toBe("watch");
  });

  // The Kick parser keeps ended campaigns so the popup visibility filters can
  // show them; farming must still ignore them.
  it("never selects an expired or completed Kick campaign for farming", async () => {
    const listCandidateChannels = vi.fn(async () => [channel("creator", { platform: "kick", url: "https://kick.com/creator" })]);

    const decision = await chooseCampaignDecision(
      "kick",
      [
        campaign("expired", { platform: "kick", status: "expired", endsAt: "2000-01-01T00:00:00.000Z" }),
        campaign("completed", { platform: "kick", status: "completed", rewards: [reward("claimed")] }),
      ],
      settings(),
      {
        listCandidateChannels,
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("idle");
    expect(listCandidateChannels).not.toHaveBeenCalled();
  });

  it("keeps upcoming campaigns visible but does not select them for farming", async () => {
    const listCandidateChannels = vi.fn(async () => [channel("creator")]);

    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("future", {
        status: "upcoming",
        eligibility: "upcoming",
        startsAt: "2999-01-01T00:00:00.000Z",
        rewards: [{
          ...reward("locked"),
          availableFrom: "2999-01-01T00:00:00.000Z",
          availableUntil: "2999-01-02T00:00:00.000Z",
        }],
      })],
      settings(),
      {
        listCandidateChannels,
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision).toMatchObject({
      action: "idle",
      reason: "Only upcoming campaigns are available and no Idle Watchlist channels",
      reasonCode: "no_eligible_channel",
    });
    expect(listCandidateChannels).not.toHaveBeenCalled();
  });

  it("prefers ACL candidates over general category streams", async () => {
    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("drops")],
      settings(),
      {
        listCandidateChannels: vi.fn(async () => [
          channel("general", { isAclMatch: false, viewerCount: 5000 }),
          channel("allowed", { isAclMatch: true, viewerCount: 1 }),
        ]),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.channel?.username).toBe("allowed");
  });

  it("skips offline and category-mismatched campaign candidates before watching", async () => {
    const offline = channel("offline", { isAclMatch: true });
    const wrongGame = channel("wrong-game", { isAclMatch: true });
    const valid = channel("valid", { isAclMatch: false });
    const checkChannel = vi.fn(async (candidate: ChannelCandidate) => ({
      live: candidate.username !== "offline",
      categoryMatches: candidate.username !== "wrong-game",
      candidate,
    }));

    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("drops")],
      settings(),
      {
        listCandidateChannels: vi.fn(async () => [offline, wrongGame, valid]),
        checkChannel,
      },
    );

    expect(decision.action).toBe("watch");
    expect(decision.channel?.username).toBe("valid");
    expect(checkChannel).toHaveBeenCalledTimes(3);
  });

  it("skips channels that do not offer the selected campaign", async () => {
    const unavailable = channel("unavailable", { isAclMatch: true });
    const valid = channel("valid", { isAclMatch: false });
    const checkChannel = vi.fn(async (candidate: ChannelCandidate) => ({
      live: true,
      categoryMatches: true,
      campaignMatches: candidate.username !== "unavailable",
      candidate,
    }));

    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("drops")],
      settings(),
      {
        listCandidateChannels: vi.fn(async () => [unavailable, valid]),
        checkChannel,
      },
    );

    expect(decision.action).toBe("watch");
    expect(decision.channel?.username).toBe("valid");
    expect(checkChannel).toHaveBeenCalledTimes(2);
  });

  it("does not select candidates whose validation cannot prove live category match", async () => {
    const unverifiable = channel("unverifiable", { isAclMatch: true });
    const valid = channel("valid", { isAclMatch: false });
    const checkChannel = vi.fn(async (candidate: ChannelCandidate) => ({
      live: candidate.username === "valid",
      categoryMatches: candidate.username === "valid",
      reason: candidate.username === "valid" ? undefined : "validation failed",
      candidate,
    }));

    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("drops")],
      settings(),
      {
        listCandidateChannels: vi.fn(async () => [unverifiable, valid]),
        checkChannel,
      },
    );

    expect(decision.action).toBe("watch");
    expect(decision.channel?.username).toBe("valid");
    expect(checkChannel).toHaveBeenCalledTimes(2);
  });

  it("skips excluded campaign candidates for the selected platform only", async () => {
    const twitchDecision = await chooseCampaignDecision(
      "twitch",
      [campaign("twitch-drops")],
      settings({
        platform: {
          ...DEFAULT_SETTINGS.platform,
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, excludedChannels: ["blocked"] },
          kick: { ...DEFAULT_SETTINGS.platform.kick, excludedChannels: ["other"] },
        },
      }),
      {
        listCandidateChannels: vi.fn(async () => [channel("blocked"), channel("allowed")]),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    const kickDecision = await chooseCampaignDecision(
      "kick",
      [campaign("kick-drops", { platform: "kick" })],
      settings({
        platform: {
          ...DEFAULT_SETTINGS.platform,
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, excludedChannels: ["blocked"] },
          kick: { ...DEFAULT_SETTINGS.platform.kick, excludedChannels: ["other"] },
        },
      }),
      {
        listCandidateChannels: vi.fn(async () => [
          channel("blocked", { platform: "kick", url: "https://kick.com/blocked" }),
        ]),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(twitchDecision.channel?.username).toBe("allowed");
    expect(kickDecision.channel?.username).toBe("blocked");
  });

  it("tries another campaign when all candidates for one campaign are excluded", async () => {
    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("first", { priority: 2 }), campaign("second", { priority: 1 })],
      settings({
        platform: {
          ...DEFAULT_SETTINGS.platform,
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, excludedChannels: ["blocked"] },
        },
      }),
      {
        listCandidateChannels: vi.fn(async (dropCampaign) => (
          dropCampaign.id === "first" ? [channel("blocked")] : [channel("allowed")]
        )),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.campaign?.id).toBe("second");
    expect(decision.channel?.username).toBe("allowed");
  });

  it("starts idle watchlist channel mode when campaigns are empty", async () => {
    const decision = await chooseCampaignDecision(
      "kick",
      [],
      settings({ platform: { kick: { enabled: true, idleWatchlistChannels: ["fallback"] } } as ExtensionSettings["platform"] }),
      {
        listCandidateChannels: vi.fn(),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("fallback");
    expect(decision.channel?.url).toBe("https://kick.com/fallback");
  });

  it("does not apply excluded drop channels to idle watchlist fallback", async () => {
    const decision = await chooseCampaignDecision(
      "kick",
      [],
      settings({
        platform: {
          ...DEFAULT_SETTINGS.platform,
          kick: { ...DEFAULT_SETTINGS.platform.kick, idleWatchlistChannels: ["fallback"], excludedChannels: ["fallback"] },
        },
      }),
      {
        listCandidateChannels: vi.fn(),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("fallback");
    expect(decision.channel?.username).toBe("fallback");
  });

  it("keeps live-check metadata on idle watchlist channel decisions", async () => {
    const decision = await chooseCampaignDecision(
      "kick",
      [],
      settings({ platform: { kick: { enabled: true, idleWatchlistChannels: ["fallback"] } } as ExtensionSettings["platform"] }),
      {
        listCandidateChannels: vi.fn(),
        checkChannel: vi.fn(async (candidate) => ({
          live: true,
          categoryMatches: true,
          candidate: {
            ...candidate,
            displayName: "Fallback",
            categoryName: "Game",
            viewerCount: 1234,
            title: "Live now",
          },
        })),
      },
    );

    expect(decision.action).toBe("fallback");
    expect(decision.channel).toMatchObject({
      username: "fallback",
      displayName: "Fallback",
      categoryName: "Game",
      viewerCount: 1234,
      title: "Live now",
    });
  });

  it("tries later idle watchlist channels when earlier fallback channels are offline", async () => {
    const decision = await chooseCampaignDecision(
      "kick",
      [],
      settings({ platform: { kick: { enabled: true, idleWatchlistChannels: ["offline", "live"] } } as ExtensionSettings["platform"] }),
      {
        listCandidateChannels: vi.fn(),
        checkChannel: vi.fn(async (candidate) => ({
          live: candidate.username === "live",
          categoryMatches: true,
          candidate,
        })),
      },
    );

    expect(decision.action).toBe("fallback");
    expect(decision.channel?.username).toBe("live");
  });

});

describe("campaign filters gate farming", () => {
  const eligibility = (
    patch: Partial<ExtensionSettings["farmingEligibility"]>,
  ): ExtensionSettings["farmingEligibility"] =>
    ({ ...DEFAULT_SETTINGS.farmingEligibility, ...patch });

  const kickAdapter = () => ({
    listCandidateChannels: vi.fn(async () => [channel("creator", { platform: "kick" as const })]),
    checkChannel: vi.fn(async (candidate: ChannelCandidate) => ({ live: true, categoryMatches: true, candidate })),
  });

  const unlinkedKick = () => campaign("unlinked", { platform: "kick", accountLinked: false });

  it("skips an unlinked Kick campaign when farmUnlinkedCampaigns is off", async () => {
    const decision = await chooseCampaignDecision(
      "kick",
      [unlinkedKick()],
      settings({ farmingEligibility: eligibility({ farmUnlinkedCampaigns: false }) }),
      kickAdapter(),
    );

    expect(decision.action).toBe("idle");
    expect(decision.reason).toContain("farming eligibility");
  });

  it("still farms an unlinked Kick campaign when farmUnlinkedCampaigns is on", async () => {
    const decision = await chooseCampaignDecision("kick", [unlinkedKick()], settings(), kickAdapter());

    expect(decision.action).toBe("watch");
    expect(decision.campaign?.id).toBe("unlinked");
  });

  const subscriptionCampaign = () => campaign("mixed", {
    rewards: [
      reward("in_progress"),
      { id: "sub", name: "Sub reward", requiredMinutes: 0, watchedMinutes: 0, requiredSubs: 1, status: "locked" },
    ],
  });

  it("skips a subscription campaign when farmSubscriptionCampaigns is off", async () => {
    const decision = await chooseCampaignDecision(
      "twitch",
      [subscriptionCampaign()],
      settings({ farmingEligibility: eligibility({ farmSubscriptionCampaigns: false }) }),
      {
        listCandidateChannels: vi.fn(async () => [channel("creator")]),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("idle");
    expect(decision.reason).toContain("farming eligibility");
  });

  it("still farms a subscription campaign's watch rewards when farmSubscriptionCampaigns is on", async () => {
    const decision = await chooseCampaignDecision(
      "twitch",
      [subscriptionCampaign()],
      settings(),
      {
        listCandidateChannels: vi.fn(async () => [channel("creator")]),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("watch");
    expect(decision.campaign?.id).toBe("mixed");
  });

  it("farms an ordinary active campaign under the default eligibility settings", async () => {
    // Nothing is turned off, so the default farmingEligibility flags must be
    // behaviour-neutral for a linked, non-subscription campaign.
    const decision = await chooseCampaignDecision(
      "twitch",
      [campaign("active")],
      settings(),
      {
        listCandidateChannels: vi.fn(async () => [channel("creator")]),
        checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
      },
    );

    expect(decision.action).toBe("watch");
    expect(decision.campaign?.id).toBe("active");
  });
});

describe("scheduler tick", () => {
  const baseState: SchedulerState = {
    authHealth: HEALTHY_AUTH,
    sessions: {
      twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
      kick: { platform: "kick", status: "idle", offlineChecks: 0 },
    },
    campaigns: { twitch: [], kick: [] },
  };

  it.each([
    ["checking", undefined],
    ["missing_credentials", "credentials_missing"],
    ["invalid_credentials", "credentials_rejected"],
    ["blocked", "security_policy_blocked"],
    ["unavailable", "platform_unavailable"],
  ] as const)("suspends account work while authentication is %s", async (status, reasonCode) => {
    const kick = {
      ...adapter("kick", [campaign("public", { platform: "kick" })], [channel("creator", { platform: "kick" })]),
      claimChallenges: vi.fn(async () => []),
      claimChannelPoints: vi.fn(async () => true),
    };
    const stopPageContextTabs = vi.fn(forgetManagedPageContextTabs);
    const previous = {
      platform: "kick" as const,
      status: "watching" as const,
      offlineChecks: 0,
      errorChecks: 2,
      retryAfter: "2099-01-01T00:00:00.000Z",
      channel: channel("creator", { platform: "kick" }),
      campaignId: "stale",
      rewardId: "reward",
      tabId: 42,
      tabManagedByExtension: true,
    };

    const result = await runSchedulerTick(
      {
        ...baseState,
        authHealth: {
          ...HEALTHY_AUTH,
          kick: { status, ...(reasonCode ? { reasonCode } : {}) },
        },
        sessions: { ...baseState.sessions, kick: previous },
        campaigns: { ...baseState.campaigns, kick: [campaign("stale", { platform: "kick" })] },
        managedWatchTabs: {
          kick: { platform: "kick", tabId: 42, channelUrl: previous.channel.url, ownedByExtension: true },
        },
      },
      settings({ platform: { twitch: { enabled: false }, kick: { enabled: true } } }),
      { twitch: adapter("twitch", [], []), kick },
      { platforms: ["kick"], stopPageContextTabs },
    );

    expect(kick.stopWatchTab).toHaveBeenCalledWith(previous);
    expect(kick.discoverCampaigns).not.toHaveBeenCalled();
    expect(kick.readProgress).not.toHaveBeenCalled();
    expect(kick.claimReward).not.toHaveBeenCalled();
    expect(kick.claimChallenges).not.toHaveBeenCalled();
    expect(kick.listCandidateChannels).not.toHaveBeenCalled();
    expect(kick.checkChannel).not.toHaveBeenCalled();
    expect(kick.prepareWatchTab).not.toHaveBeenCalled();
    expect(kick.claimChannelPoints).not.toHaveBeenCalled();
    expect(result.state.campaigns.kick).toEqual([]);
    expect(result.state.managedWatchTabs?.kick).toBeUndefined();
    expect(stopPageContextTabs).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ platforms: ["kick"], reason: "authentication_unhealthy" }),
    );
    expect(result.state.sessions.kick).toMatchObject({
      status: "paused",
      reasonCode: "authentication_unhealthy",
      errorChecks: 2,
      retryAfter: undefined,
      channel: undefined,
      campaignId: undefined,
      rewardId: undefined,
    });
  });

  it("returns claim activity in the event batch without mutating scheduler state", async () => {
    const ready = campaign("drops", { rewards: [reward("claimable")] });
    const result = await runSchedulerTick(
      baseState,
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch: adapter("twitch", [ready], []), kick: adapter("kick", [], []) },
    );

    expect(result.state).not.toHaveProperty("events");
    expect(result.events).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "reward_claimed",
      data: expect.objectContaining({ method: "automatic" }),
    }));
  });

  it("does not repeat diagnostics for an unchanged healthy target", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("creator")]);
    const tickSettings = settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } });
    const tickAdapters = { twitch, kick: adapter("kick", [], []) };
    const first = await runSchedulerTick(baseState, tickSettings, tickAdapters);
    const second = await runSchedulerTick(first.state, tickSettings, tickAdapters);

    expect(second.events.filter((event) => event.category === "diagnostic" && event.message.startsWith("Campaign decision:"))).toEqual([]);
    expect(second.events.filter((event) => event.category === "diagnostic" && event.message.includes("campaigns eligible"))).toEqual([]);
  });

  it("emits structured diagnostics for rewards excluded by deadline feasibility", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-19T12:00:00.000Z");
    try {
      const timed = campaign("drops", { endsAt: "2026-07-19T12:44:59.999Z" });
      const result = await runSchedulerTick(
        baseState,
        settings({
          deadlineSafetyMarginMinutes: 5,
          platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } },
        }),
        { twitch: adapter("twitch", [timed], []), kick: adapter("kick", [], []) },
      );

      expect(result.events).toContainEqual(expect.objectContaining({
        category: "diagnostic",
        code: "reward_insufficient_time",
        data: expect.objectContaining({
          campaignId: "drops",
          rewardId: "reward-in_progress",
          remainingMinutes: 40,
          marginMinutes: 5,
          deadline: "2026-07-19T12:44:59.999Z",
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a deadline diagnostic once when unchanged campaigns become infeasible over time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-19T12:00:00.000Z");
    try {
      const timed = campaign("drops", { endsAt: "2026-07-19T12:50:00.000Z" });
      const twitch = adapter("twitch", [timed], []);
      const tickSettings = settings({
        deadlineSafetyMarginMinutes: 5,
        platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } },
      });
      const tickAdapters = { twitch, kick: adapter("kick", [], []) };

      const first = await runSchedulerTick(baseState, tickSettings, tickAdapters);
      expect(first.events.filter((event) => event.code === "reward_insufficient_time")).toEqual([]);

      vi.setSystemTime("2026-07-19T12:06:00.000Z");
      const second = await runSchedulerTick(first.state, tickSettings, tickAdapters);
      expect(second.events.filter((event) => event.code === "reward_insufficient_time")).toHaveLength(1);

      const third = await runSchedulerTick(second.state, tickSettings, tickAdapters);
      expect(third.events.filter((event) => event.code === "reward_insufficient_time")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not classify a missing replacement reward as completed", async () => {
    const currentChannel = channel("creator");
    const twitch = adapter("twitch", [campaign("drops")], [currentChannel]);
    const result = await runSchedulerTick(
      {
        ...baseState,
        authHealth: HEALTHY_AUTH,
        sessions: {
          ...baseState.sessions,
          twitch: {
            platform: "twitch",
            status: "watching",
            campaignId: "drops",
            rewardId: "missing-reward",
            channel: currentChannel,
            offlineChecks: 0,
            playback: {
              platform: "twitch",
              checkedAt: new Date().toISOString(),
              videoCount: 1,
              playingVideoCount: 1,
              mutedVideoCount: 1,
              unmutedVideoCount: 0,
              blockedPlaybackCount: 0,
              documentHidden: false,
            },
          },
        },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.reasonCode).not.toBe("watch_requirement_completed");
  });

  it("classifies a refreshed claimed reward as completed when the next decision is idle", async () => {
    const currentChannel = channel("creator");
    const completedReward = reward("claimed");
    const twitch = adapter("twitch", [campaign("drops", { rewards: [completedReward] })], []);
    const result = await runSchedulerTick(
      {
        ...baseState,
        authHealth: HEALTHY_AUTH,
        sessions: {
          ...baseState.sessions,
          twitch: {
            platform: "twitch",
            status: "watching",
            campaignId: "drops",
            rewardId: completedReward.id,
            channel: currentChannel,
            offlineChecks: 0,
          },
        },
      },
      settings({
        autoClaim: false,
        platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } },
      }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.decisions[0].action).toBe("idle");
    expect(result.state.sessions.twitch.reasonCode).toBe("watch_requirement_completed");
  });

  it("classifies a refreshed claimable reward as completed when switching to Idle Watchlist fallback", async () => {
    const currentChannel = channel("creator");
    const completedReward = reward("claimable");
    const twitch = adapter("twitch", [campaign("drops", { rewards: [completedReward] })], []);
    const result = await runSchedulerTick(
      {
        ...baseState,
        authHealth: HEALTHY_AUTH,
        sessions: {
          ...baseState.sessions,
          twitch: {
            platform: "twitch",
            status: "watching",
            campaignId: "drops",
            rewardId: completedReward.id,
            channel: currentChannel,
            offlineChecks: 0,
          },
        },
      },
      settings({
        autoClaim: false,
        platform: { twitch: { enabled: true, idleWatchlistChannels: ["fallback"] }, kick: { enabled: false, idleWatchlistChannels: [] } },
      }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.decisions[0].action).toBe("fallback");
    expect(result.state.sessions.twitch.reasonCode).toBe("watch_requirement_completed");
  });

  it("switches after offline retry threshold", async () => {
    const first = channel("old");
    const next = channel("new");
    const twitch = adapter("twitch", [campaign("drops")], [next]);
    vi.mocked(twitch.checkChannel).mockImplementation(async (candidate) => ({
      live: candidate.username !== "old",
      categoryMatches: true,
      candidate,
    }));

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "watching", channel: first, offlineChecks: 2, tabId: 7 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ offlineRetryLimit: 3, platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.channel?.username).toBe("new");
    expect(result.state.sessions.twitch.offlineChecks).toBe(0);
    expect(twitch.prepareWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ username: "new", live: true }),
      expect.objectContaining({ tabId: 7 }),
      {},
    );
    expect(twitch.readProgress).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ channel: first }));
  });

  it("pauses only the platform with recent manual watch activity", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("creator")]);
    const kick = adapter("kick", [campaign("kick-drops", { platform: "kick" })], [
      channel("kick-creator", { platform: "kick", url: "https://kick.com/kick-creator" }),
    ]);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "watching", channel: channel("old"), offlineChecks: 0, tabId: 7, tabManagedByExtension: true },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        manualWatch: {
          twitch: { platform: "twitch", tabId: 99, active: true, checkedAt: new Date().toISOString() },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: true, idleWatchlistChannels: [] } } }),
      { twitch, kick },
    );

    expect(result.state.sessions.twitch).toMatchObject({
      status: "paused",
      message: "Manual watch detected",
      reasonCode: "manual_watch",
      tabId: undefined,
    });
    expect(twitch.stopWatchTab).toHaveBeenCalled();
    expect(twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(result.state.sessions.kick.status).toBe("watching");
    expect(kick.prepareWatchTab).toHaveBeenCalled();
  });

  it("ignores stale manual watch activity", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("creator")]);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        manualWatch: {
          twitch: { platform: "twitch", tabId: 99, active: true, checkedAt: new Date(Date.now() - 60_000).toISOString() },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.status).toBe("watching");
    expect(twitch.prepareWatchTab).toHaveBeenCalled();
  });

  it("returns diagnostics without host log filtering", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("creator")]);
    const adapters = () => ({ twitch, kick: adapter("kick", [], []) });

    const quiet = await runSchedulerTick(baseState, settings(), adapters());
    expect(quiet.events.some((event) => event.category === "diagnostic" && event.level === "debug")).toBe(true);
    expect(quiet.events.some((event) => event.category === "diagnostic" && event.message.startsWith("Campaign inventory changed"))).toBe(true);
    expect(quiet.events.some((event) => event.category === "diagnostic" && event.message.startsWith("Tick start"))).toBe(false);
  });

  it("switches on category mismatch", async () => {
    const old = channel("old");
    const next = channel("new");
    const twitch = adapter("twitch", [campaign("drops")], [next]);
    vi.mocked(twitch.checkChannel).mockImplementation(async (candidate) => ({
      live: true,
      categoryMatches: candidate.username !== "old",
      candidate,
    }));

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "watching", channel: old, offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.channel?.username).toBe("new");
  });

  it("switches to a higher-priority idle watchlist channel after the watchlist is reordered", async () => {
    const toonyx = channel("toonyx", { url: "https://www.twitch.tv/toonyx" });
    const twitch = adapter("twitch", [], []);
    // No campaigns -> fallback mode. Both fallbacks are live; "xqc" is now first.
    vi.mocked(twitch.checkChannel).mockImplementation(async (candidate) => ({ live: true, categoryMatches: true, candidate }));

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "watching", channel: toonyx, offlineChecks: 0, tabId: 7 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: ["xqc", "toonyx"] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.channel?.username).toBe("xqc");
  });

  it("keeps the current channel when the same campaign has another valid candidate", async () => {
    const old = channel("old");
    const next = channel("new");
    const twitch = adapter("twitch", [campaign("drops")], [next]);
    vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: old });

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: old,
            campaignId: "drops",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
            tabId: 7,
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.channel?.username).toBe("old");
    expect(twitch.prepareWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ username: "old" }),
      expect.objectContaining({ tabId: 7 }),
      {},
    );
  });

  it("switches away from the current campaign channel when it becomes excluded", async () => {
    const old = channel("old");
    const next = channel("new");
    const twitch = adapter("twitch", [campaign("drops")], [next]);
    vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: old });

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: old,
            campaignId: "drops",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
            tabId: 7,
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({
        platform: {
          ...DEFAULT_SETTINGS.platform,
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true, idleWatchlistChannels: [], excludedChannels: ["old"] },
          kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
        },
      }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.channel?.username).toBe("new");
    expect(result.state.sessions.twitch.message).toBe("Current channel is excluded from drops");
    expect(twitch.prepareWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ username: "new" }),
      expect.objectContaining({ tabId: 7 }),
      {},
    );
  });

  it("keeps playback telemetry for healthy watch tabs", async () => {
    const old = channel("old");
    const twitch = adapter("twitch", [campaign("drops")], [channel("new")]);
    vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: old });

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: old,
            campaignId: "drops",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
            playbackChecks: 2,
            tabId: 7,
            playback: {
              platform: "twitch",
              checkedAt: new Date().toISOString(),
              videoCount: 1,
              mutedVideoCount: 0,
              unmutedVideoCount: 1,
              playingVideoCount: 1,
              blockedPlaybackCount: 0,
              documentHidden: true,
            },
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.playbackChecks).toBe(0);
    expect(result.state.sessions.twitch.playback?.playingVideoCount).toBe(1);
  });

  it("treats a muted but playing watch tab as healthy", async () => {
    const old = channel("old");
    const twitch = adapter("twitch", [campaign("drops")], [channel("new")]);
    vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: old });

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: old,
            campaignId: "drops",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
            playbackChecks: 2,
            tabId: 7,
            playback: {
              platform: "twitch",
              checkedAt: new Date().toISOString(),
              videoCount: 1,
              mutedVideoCount: 1,
              unmutedVideoCount: 0,
              playingVideoCount: 1,
              blockedPlaybackCount: 1,
              documentHidden: true,
            },
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.playbackChecks).toBe(0);
    expect(result.state.sessions.twitch.playback?.playingVideoCount).toBe(1);
  });

  it("refreshes viewer metadata while keeping the current watch tab", async () => {
    const old = channel("old", { viewerCount: 10, title: "Old title" });
    const twitch = adapter("twitch", [campaign("drops")], [channel("new")]);
    vi.mocked(twitch.checkChannel).mockResolvedValue({
      live: true,
      categoryMatches: true,
      candidate: {
        ...old,
        categoryName: "Updated game",
        viewerCount: 1234,
        title: "Updated title",
      },
    });

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: old,
            campaignId: "drops",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
            tabId: 7,
            playback: {
              platform: "twitch",
              checkedAt: new Date().toISOString(),
              videoCount: 1,
              mutedVideoCount: 0,
              unmutedVideoCount: 1,
              playingVideoCount: 1,
              blockedPlaybackCount: 0,
              documentHidden: true,
            },
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.channel).toMatchObject({
      username: "old",
      categoryName: "Updated game",
      viewerCount: 1234,
      title: "Updated title",
    });
  });

  it("reloads the watch tab after repeated playback failures", async () => {
    const old = channel("old");
    const twitch = adapter("twitch", [campaign("drops")], [old]);
    vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: old });

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: old,
            campaignId: "drops",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
            playbackChecks: 2,
            tabId: 7,
            playback: {
              platform: "twitch",
              checkedAt: new Date().toISOString(),
              videoCount: 1,
              mutedVideoCount: 0,
              unmutedVideoCount: 1,
              playingVideoCount: 0,
              blockedPlaybackCount: 1,
              documentHidden: true,
            },
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({
        offlineRetryLimit: 3,
        platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } },
      }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.message).toBe("Watch tab playback did not become active");
    expect(result.state.sessions.twitch.reasonCode).toBe("watch_unhealthy");
    expect(result.state.sessions.twitch.playback).toBeUndefined();
    // The replacement tab starts with a clean counter and a fresh grace window.
    expect(result.state.sessions.twitch.playbackChecks).toBe(0);
    expect(result.state.sessions.twitch.watchTabOpenedAt).toBeDefined();
    expect(twitch.prepareWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ username: "old" }),
      expect.objectContaining({ tabId: 7 }),
      {},
    );
    expect(result.events.some((event) => event.category === "diagnostic" && event.message === "Watch tab playback did not become active")).toBe(true);
  });

  it("does not condemn a freshly opened watch tab whose player has not attached yet (#250)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-19T12:00:00.000Z");
    try {
      const old = channel("old");
      const twitch = adapter("twitch", [campaign("drops")], [old]);
      vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: old });
      vi.mocked(twitch.prepareWatchTab).mockResolvedValue({ tabId: 7, managedByExtension: true });
      // The user log: tab opens, reports "0/0 videos playing", and only reports
      // playback a couple of seconds later.
      const coldTab: SchedulerState["sessions"]["twitch"] = {
        platform: "twitch",
        status: "watching",
        channel: old,
        campaignId: "drops",
        rewardId: "reward-in_progress",
        offlineChecks: 0,
        playbackChecks: 0,
        tabId: 7,
        watchMode: "tab",
        watchTabOpenedAt: new Date().toISOString(),
        playback: {
          platform: "twitch",
          checkedAt: new Date().toISOString(),
          videoCount: 0,
          mutedVideoCount: 0,
          unmutedVideoCount: 0,
          playingVideoCount: 0,
          blockedPlaybackCount: 0,
          documentHidden: true,
        },
      };
      const engineSettings = settings({
        offlineRetryLimit: 3,
        platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } },
      });

      let session = coldTab;
      // Several off-cycle ticks inside the grace window must not accumulate.
      for (let tick = 0; tick < 4; tick += 1) {
        vi.setSystemTime(new Date(Date.parse("2026-07-19T12:00:00.000Z") + (tick + 1) * 2_000));
        const result = await runSchedulerTick(
          {
            authHealth: HEALTHY_AUTH,
            sessions: { twitch: session, kick: { platform: "kick", status: "idle", offlineChecks: 0 } },
            campaigns: { twitch: [], kick: [] },
          },
          engineSettings,
          { twitch, kick: adapter("kick", [], []) },
        );
        session = { ...result.state.sessions.twitch, playback: session.playback };
        expect(session.reasonCode).not.toBe("watch_unhealthy");
        expect(session.playbackChecks).toBe(0);
        expect(session.tabId).toBe(7);
      }

      // Telemetry finally reports playback; the tab is kept.
      session = {
        ...session,
        playback: {
          platform: "twitch",
          checkedAt: new Date().toISOString(),
          videoCount: 1,
          mutedVideoCount: 1,
          unmutedVideoCount: 0,
          playingVideoCount: 1,
          blockedPlaybackCount: 0,
          documentHidden: true,
        },
      };
      const settled = await runSchedulerTick(
        {
          authHealth: HEALTHY_AUTH,
          sessions: { twitch: session, kick: { platform: "kick", status: "idle", offlineChecks: 0 } },
          campaigns: { twitch: [], kick: [] },
        },
        engineSettings,
        { twitch, kick: adapter("kick", [], []) },
      );

      expect(settled.state.sessions.twitch.reasonCode).toBe("keeping_current_watch");
      expect(settled.state.sessions.twitch.playbackChecks).toBe(0);
      expect(settled.state.sessions.twitch.tabId).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still replaces a watch tab that never plays once the grace period has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-19T12:00:00.000Z");
    try {
      const old = channel("old");
      const twitch = adapter("twitch", [campaign("drops")], [old]);
      vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: old });
      const deadPlayback = {
        platform: "twitch" as const,
        checkedAt: new Date().toISOString(),
        videoCount: 1,
        mutedVideoCount: 1,
        unmutedVideoCount: 0,
        playingVideoCount: 0,
        blockedPlaybackCount: 1,
        documentHidden: true,
      };
      const result = await runSchedulerTick(
        {
          authHealth: HEALTHY_AUTH,
          sessions: {
            twitch: {
              platform: "twitch",
              status: "watching",
              channel: old,
              campaignId: "drops",
              rewardId: "reward-in_progress",
              offlineChecks: 0,
              playbackChecks: 2,
              tabId: 7,
              watchMode: "tab",
              // Opened well before the grace window closed.
              watchTabOpenedAt: "2026-07-19T11:50:00.000Z",
              playback: deadPlayback,
            },
            kick: { platform: "kick", status: "idle", offlineChecks: 0 },
          },
          campaigns: { twitch: [], kick: [] },
        },
        settings({
          offlineRetryLimit: 3,
          platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } },
        }),
        { twitch, kick: adapter("kick", [], []) },
      );

      expect(result.state.sessions.twitch.reasonCode).toBe("watch_unhealthy");
      expect(twitch.prepareWatchTab).toHaveBeenCalledWith(
        expect.objectContaining({ username: "old" }),
        expect.objectContaining({ tabId: 7 }),
        {},
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps the watch tab open time on a new tab and keeps it while the tab survives", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-19T12:00:00.000Z");
    try {
      const old = channel("old");
      const twitch = adapter("twitch", [campaign("drops")], [old]);
      vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: old });
      vi.mocked(twitch.prepareWatchTab).mockResolvedValue({ tabId: 7, managedByExtension: true });

      const opened = await runSchedulerTick(
        {
          authHealth: HEALTHY_AUTH,
          sessions: {
            twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
            kick: { platform: "kick", status: "idle", offlineChecks: 0 },
          },
          campaigns: { twitch: [], kick: [] },
        },
        settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
        { twitch, kick: adapter("kick", [], []) },
      );

      expect(opened.state.sessions.twitch.watchTabOpenedAt).toBe("2026-07-19T12:00:00.000Z");

      vi.setSystemTime("2026-07-19T12:05:00.000Z");
      const kept = await runSchedulerTick(
        {
          authHealth: HEALTHY_AUTH,
          sessions: {
            twitch: {
              ...opened.state.sessions.twitch,
              playback: {
                platform: "twitch",
                checkedAt: new Date().toISOString(),
                videoCount: 1,
                mutedVideoCount: 1,
                unmutedVideoCount: 0,
                playingVideoCount: 1,
                blockedPlaybackCount: 0,
                documentHidden: true,
              },
            },
            kick: { platform: "kick", status: "idle", offlineChecks: 0 },
          },
          campaigns: { twitch: [], kick: [] },
        },
        settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
        { twitch, kick: adapter("kick", [], []) },
      );

      expect(kept.state.sessions.twitch.watchTabOpenedAt).toBe("2026-07-19T12:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches from a campaign watch tab to fallback when the campaign becomes ineligible", async () => {
    const old = channel("old");
    const fallback = channel("fallback", { platform: "twitch", url: "https://www.twitch.tv/fallback" });
    const twitch = adapter("twitch", [campaign("done", { status: "completed" })], []);
    vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: fallback });

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: old,
            campaignId: "done",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
            tabId: 7,
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: ["fallback"] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.sessions.twitch.campaignId).toBeUndefined();
    expect(result.state.sessions.twitch.channel?.username).toBe("fallback");
    expect(twitch.prepareWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ username: "fallback" }),
      expect.objectContaining({ tabId: 7 }),
      {},
    );
  });

  it("claims ready rewards before watching", async () => {
    const ready = campaign("drops", { rewards: [reward("claimable")] });
    const twitch = adapter("twitch", [ready], [channel("allowed")]);

    await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.claimReward).toHaveBeenCalledWith(ready, ready.rewards[0]);
  });

  it("claims an obtained non-watch reward without selecting it for farming", async () => {
    const actionReward = {
      ...reward("claimable"),
      requiredMinutes: 0,
      watchedMinutes: 0,
      isWatchBased: false,
      requirement: "subscription" as const,
      requiredSubs: 1,
      claimId: "subscription-instance",
    };
    const ready = campaign("subscription-drops", {
      eligibility: "waiting_for_subscription",
      rewards: [actionReward],
    });
    const twitch = adapter("twitch", [ready], [channel("allowed")]);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.claimReward).toHaveBeenCalledWith(ready, actionReward);
    expect(twitch.listCandidateChannels).not.toHaveBeenCalled();
    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(result.state.sessions.twitch.status).toBe("idle");
  });

  it("keeps a locked subscription-only campaign idle", async () => {
    const subscriptionReward = {
      ...reward("locked"),
      requiredMinutes: 0,
      watchedMinutes: 0,
      isWatchBased: false,
      requirement: "subscription" as const,
      requiredSubs: 1,
    };
    const waiting = campaign("subscription-drops", {
      eligibility: "waiting_for_subscription",
      rewards: [subscriptionReward],
    });
    const twitch = adapter("twitch", [waiting], [channel("allowed")]);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.listCandidateChannels).not.toHaveBeenCalled();
    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(result.state.sessions.twitch.status).toBe("idle");
    expect(result.state.sessions.twitch.reasonCode).toBe("campaign_ineligible");
    expect(result.state.sessions.twitch.message).toContain("Waiting for a qualifying subscription");
  });

  it("does not start a live Idle Watchlist fallback for subscription-only campaigns", async () => {
    const waiting = campaign("subscription-drops", {
      eligibility: "waiting_for_subscription",
      rewards: [{
        ...reward("locked"),
        requiredMinutes: 0,
        watchedMinutes: 0,
        requirement: "subscription",
        requiredSubs: 1,
        isWatchBased: false,
      }],
    });
    const twitch = adapter("twitch", [waiting], []);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: ["fallback"] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.checkChannel).not.toHaveBeenCalled();
    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(result.state.sessions.twitch).toMatchObject({
      status: "idle",
      reasonCode: "campaign_ineligible",
    });
  });

  it.each(["claimed", "claimable"] as const)(
    "does not start Idle Watchlist when a historical watch reward is %s and only a subscription reward remains",
    async (watchStatus) => {
      const waiting = campaign("mixed-drops", {
        eligibility: "waiting_for_subscription",
        rewards: [
          { ...reward(watchStatus), requirement: "watch" },
          {
            ...reward("locked"),
            id: "subscription-reward",
            requiredMinutes: 0,
            watchedMinutes: 0,
            requirement: "subscription",
            requiredSubs: 1,
            isWatchBased: false,
          },
        ],
      });
      const checkChannel = vi.fn(async (candidate: ChannelCandidate) => ({
        live: true,
        categoryMatches: true,
        candidate,
      }));

      const decision = await chooseCampaignDecision(
        "twitch",
        [waiting],
        settings({ platform: { twitch: { idleWatchlistChannels: ["fallback"] } } }),
        {
          listCandidateChannels: vi.fn(async () => []),
          checkChannel,
        },
      );

      expect(checkChannel).not.toHaveBeenCalled();
      expect(decision).toMatchObject({
        action: "idle",
        reasonCode: "campaign_ineligible",
      });
    },
  );

  it("stops an existing Idle Watchlist fallback when only subscription campaigns remain", async () => {
    const waiting = campaign("subscription-drops", {
      eligibility: "waiting_for_subscription",
      rewards: [{
        ...reward("locked"),
        requiredMinutes: 0,
        watchedMinutes: 0,
        requirement: "subscription",
        requiredSubs: 1,
        isWatchBased: false,
      }],
    });
    const twitch = adapter("twitch", [waiting], []);
    const fallback = channel("fallback");

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: fallback,
            offlineChecks: 0,
            tabId: 7,
            tabManagedByExtension: true,
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: ["fallback"] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.stopWatchTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7 }));
    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(result.state.sessions.twitch).toMatchObject({
      status: "idle",
      reasonCode: "campaign_ineligible",
    });
    expect(result.state.sessions.twitch.channel).toBeUndefined();
  });

  it("unlocks and selects a chained watch reward after claiming its subscription prerequisite", async () => {
    const subscriptionReward: DropReward = {
      ...reward("claimable"),
      id: "subscription-reward",
      requiredMinutes: 0,
      watchedMinutes: 0,
      isWatchBased: false,
      requirement: "subscription",
      requiredSubs: 1,
      claimId: "subscription-instance",
    };
    const watchReward: DropReward = {
      ...reward("locked"),
      id: "watch-reward",
      requirement: "watch",
      preconditionRewardIds: [subscriptionReward.id],
      preconditionsMet: false,
    };
    const chained = campaign("chained-drops", {
      eligibility: "eligible",
      rewards: [subscriptionReward, watchReward],
    });
    const twitch = adapter("twitch", [chained], [channel("allowed")]);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.campaigns.twitch[0].rewards).toEqual([
      expect.objectContaining({ id: subscriptionReward.id, status: "claimed" }),
      expect.objectContaining({ id: watchReward.id, preconditionsMet: true }),
    ]);
    expect(result.state.sessions.twitch).toMatchObject({
      status: "watching",
      campaignId: chained.id,
      rewardId: watchReward.id,
    });
    expect(twitch.prepareWatchTab).toHaveBeenCalled();
  });

  it("defers claiming a ready reward until the adapter reports it is claim-ready", async () => {
    const ready = campaign("drops", { rewards: [reward("claimable")] });
    const twitch = { ...adapter("twitch", [ready], [channel("allowed")]), isClaimReady: vi.fn(() => false) };

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.claimReward).not.toHaveBeenCalled();
    expect(result.state.campaigns.twitch[0].rewards[0].status).toBe("claimable");
    const claimEvents = result.events.filter((event) => event.category === "diagnostic" && event.message.includes("waiting for"));
    expect(claimEvents).toHaveLength(1);
    expect(claimEvents[0].level).toBe("info");
    // No "Could not claim" warning or claim error is emitted while deferring.
    expect(result.events.some((event) => event.category === "diagnostic" && /claim/i.test(event.message) && event.level !== "info")).toBe(false);
  });

  it("reports an unreleased claim only when it first enters the waiting state", async () => {
    const ready = campaign("drops", { rewards: [reward("claimable")] });
    const twitch = { ...adapter("twitch", [ready], [channel("allowed")]), isClaimReady: vi.fn(() => false) };
    const waitingClaimRewardIds = { twitch: new Set<string>(), kick: new Set<string>() };
    const options = { waitingClaimRewardIds };
    const initialState: SchedulerState = {
      authHealth: HEALTHY_AUTH,
      sessions: {
        twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
        kick: { platform: "kick", status: "idle", offlineChecks: 0 },
      },
      campaigns: { twitch: [], kick: [] },
    };
    const enabledSettings = settings({
      platform: {
        twitch: { enabled: true, idleWatchlistChannels: [] },
        kick: { enabled: false, idleWatchlistChannels: [] },
      },
    });

    const first = await runSchedulerTick(initialState, enabledSettings, { twitch, kick: adapter("kick", [], []) }, options);
    const second = await runSchedulerTick(first.state, enabledSettings, { twitch, kick: adapter("kick", [], []) }, options);

    expect(first.events.filter((event) => event.category === "diagnostic" && event.message.includes("waiting for"))).toHaveLength(1);
    expect(second.events.filter((event) => event.category === "diagnostic" && event.message.includes("waiting for"))).toHaveLength(0);
    expect(second.state.campaigns.twitch[0].rewards[0].status).toBe("claimable");
    expect(twitch.claimReward).not.toHaveBeenCalled();
  });

  it("reports a reward again when it re-enters the unreleased-claim state", async () => {
    const ready = campaign("drops", { rewards: [reward("claimable")] });
    const isClaimReady = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const twitch = { ...adapter("twitch", [ready], [channel("allowed")]), isClaimReady };
    const waitingClaimRewardIds = { twitch: new Set<string>(), kick: new Set<string>() };
    const options = { waitingClaimRewardIds };
    const initialState: SchedulerState = {
      authHealth: HEALTHY_AUTH,
      sessions: {
        twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
        kick: { platform: "kick", status: "idle", offlineChecks: 0 },
      },
      campaigns: { twitch: [], kick: [] },
    };
    const enabledSettings = settings({
      platform: {
        twitch: { enabled: true, idleWatchlistChannels: [] },
        kick: { enabled: false, idleWatchlistChannels: [] },
      },
    });
    const adapters = { twitch, kick: adapter("kick", [], []) };

    const first = await runSchedulerTick(initialState, enabledSettings, adapters, options);
    expect(waitingClaimRewardIds.twitch).toContain("reward-claimable");
    const released = await runSchedulerTick(first.state, enabledSettings, adapters, options);
    expect(waitingClaimRewardIds.twitch).not.toContain("reward-claimable");
    const reentered = await runSchedulerTick(released.state, enabledSettings, adapters, options);

    expect(first.events.filter((event) => event.category === "diagnostic" && event.message.includes("waiting for"))).toHaveLength(1);
    expect(reentered.events.filter((event) => event.category === "diagnostic" && event.message.includes("waiting for"))).toHaveLength(1);
  });

  it("claims a ready reward once the adapter reports it is claim-ready", async () => {
    const ready = campaign("drops", { rewards: [reward("claimable")] });
    const twitch = { ...adapter("twitch", [ready], [channel("allowed")]), isClaimReady: vi.fn(() => true) };

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.claimReward).toHaveBeenCalledWith(ready, ready.rewards[0]);
    expect(result.state.campaigns.twitch[0].rewards[0].status).toBe("claimed");
  });

  it("does not claim rewards after their claim window has expired", async () => {
    const ready = campaign("drops", { rewards: [{ ...reward("claimable"), claimUntil: "2020-01-01T00:00:00.000Z" }] });
    const twitch = adapter("twitch", [ready], [channel("allowed")]);

    await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.claimReward).not.toHaveBeenCalled();
  });

  it("does not open a watch tab for claimable-only campaigns when auto-claim is disabled", async () => {
    const ready = campaign("drops", { rewards: [reward("claimable")] });
    const twitch = adapter("twitch", [ready], [channel("allowed")]);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({
        autoClaim: false,
        platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } },
      }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(result.state.sessions.twitch.status).toBe("idle");
  });

  it("opens no watch tab when automation is enabled without eligible campaigns or live fallback", async () => {
    const twitch = adapter("twitch", [], []);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(result.state.sessions.twitch.status).toBe("idle");
    expect(result.state.sessions.twitch.tabId).toBeUndefined();
    expect(result.state.managedWatchTabs?.twitch).toBeUndefined();
  });

  it("opens exactly one managed watch tab when only one platform has an eligible target", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("allowed")]);
    const kick = adapter("kick", [], []);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: true, idleWatchlistChannels: [] } } }),
      { twitch, kick },
    );

    expect(twitch.prepareWatchTab).toHaveBeenCalledTimes(1);
    expect(kick.prepareWatchTab).not.toHaveBeenCalled();
    expect(Object.keys(result.state.managedWatchTabs ?? {})).toEqual(["twitch"]);
  });

  it("opens one managed watch tab per platform when both platforms have eligible targets", async () => {
    const twitch = adapter("twitch", [campaign("twitch-drops")], [channel("twitch-allowed")]);
    const kickCandidate = { ...channel("kick-allowed"), platform: "kick" as const, url: "https://kick.com/kick-allowed" };
    const kick = adapter("kick", [campaign("kick-drops", { platform: "kick" })], [kickCandidate]);
    vi.mocked(kick.prepareWatchTab).mockResolvedValue({ tabId: 84, managedByExtension: true });

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: true, idleWatchlistChannels: [] } } }),
      { twitch, kick },
    );

    expect(twitch.prepareWatchTab).toHaveBeenCalledTimes(1);
    expect(kick.prepareWatchTab).toHaveBeenCalledTimes(1);
    expect(result.state.managedWatchTabs).toMatchObject({
      twitch: { platform: "twitch", tabId: 42 },
      kick: { platform: "kick", tabId: 84 },
    });
  });

  it("retains a required Kick page context across ordinary watch preparation", async () => {
    const kickCandidate = { ...channel("kick-allowed"), platform: "kick" as const, url: "https://kick.com/kick-allowed" };
    const kick = adapter("kick", [campaign("kick-drops", { platform: "kick" })], [kickCandidate]);
    const stopPageContextTabs = vi.fn(forgetManagedPageContextTabs);
    const managedContext = {
      platform: "kick" as const,
      tabId: 91,
      originUrl: "https://kick.com",
      origin: "https://kick.com",
      ownedByExtension: true as const,
    };

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        managedPageContextTabs: { kick: managedContext },
      },
      settings({ platform: { twitch: { enabled: false }, kick: { enabled: true } } }),
      { twitch: adapter("twitch", [], []), kick },
      { platforms: ["kick"], stopPageContextTabs },
    );

    expect(kick.prepareWatchTab).toHaveBeenCalledOnce();
    expect(stopPageContextTabs).not.toHaveBeenCalled();
    expect(result.state.managedPageContextTabs?.kick).toEqual(managedContext);
  });

  it("only evaluates requested platforms during a targeted tick", async () => {
    const twitch = adapter("twitch", [campaign("twitch-drops")], [channel("twitch-allowed")]);
    const kickCandidate = { ...channel("kick-allowed"), platform: "kick" as const, url: "https://kick.com/kick-allowed" };
    const kick = adapter("kick", [campaign("kick-drops", { platform: "kick" })], [kickCandidate]);
    vi.mocked(kick.prepareWatchTab).mockResolvedValue({ tabId: 84, managedByExtension: true });

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "watching", channel: channel("current"), offlineChecks: 0, tabId: 42, tabManagedByExtension: true },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [campaign("existing")], kick: [] },
        managedWatchTabs: {
          twitch: { platform: "twitch", tabId: 42, channelUrl: "https://www.twitch.tv/current", ownedByExtension: true },
        },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: true, idleWatchlistChannels: [] } } }),
      { twitch, kick },
      { platforms: ["kick"] },
    );

    expect(twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(result.state.sessions.twitch.status).toBe("watching");
    expect(result.state.campaigns.twitch).toEqual([campaign("existing")]);
    expect(kick.prepareWatchTab).toHaveBeenCalledTimes(1);
    expect(result.state.sessions.kick.status).toBe("watching");
  });

  it("passes the existing managed tab into repeated ticks instead of creating an untracked tab", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("allowed")]);
    const initialState = {
      authHealth: HEALTHY_AUTH,
      sessions: {
        twitch: { platform: "twitch" as const, status: "idle" as const, offlineChecks: 0 },
        kick: { platform: "kick" as const, status: "idle" as const, offlineChecks: 0 },
      },
      campaigns: { twitch: [], kick: [] },
    };
    const tickSettings = settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } });

    const first = await runSchedulerTick(initialState, tickSettings, { twitch, kick: adapter("kick", [], []) });
    await runSchedulerTick(first.state, tickSettings, { twitch, kick: adapter("kick", [], []) });

    expect(twitch.prepareWatchTab).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ username: "allowed" }),
      expect.objectContaining({ tabId: 42 }),
      expect.objectContaining({
        managedTab: expect.objectContaining({ platform: "twitch", tabId: 42 }),
      }),
    );
  });

  it("stops the previous watch tab when automation is disabled", async () => {
    const twitch = adapter("twitch", [], []);
    const stopPageContextTabs = vi.fn(forgetManagedPageContextTabs);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "watching", channel: channel("old"), offlineChecks: 0, tabId: 7, tabManagedByExtension: true },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        managedPageContextTabs: {
          twitch: {
            platform: "twitch",
            tabId: 9,
            originUrl: "https://www.twitch.tv/drops/inventory",
            origin: "https://www.twitch.tv",
            ownedByExtension: true,
          },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ running: false }),
      { twitch, kick: adapter("kick", [], []) },
      { stopPageContextTabs },
    );

    expect(twitch.stopWatchTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7, tabManagedByExtension: true }));
    expect(result.state.sessions.twitch.tabId).toBeUndefined();
    expect(result.state.sessions.twitch.channel).toBeUndefined();
    expect(result.state.managedPageContextTabs?.twitch).toBeUndefined();
    expect(stopPageContextTabs).toHaveBeenCalledWith(
      expect.objectContaining({ twitch: expect.objectContaining({ tabId: 9 }) }),
      expect.objectContaining({ platforms: ["twitch"], reason: "automation_disabled", emit: expect.any(Function) }),
    );
  });

  it("stops the previous watch tab when no eligible campaigns or fallback remain", async () => {
    const twitch = adapter("twitch", [], []);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "watching", channel: channel("old"), offlineChecks: 0, tabId: 7, tabManagedByExtension: true },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.stopWatchTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7 }));
    expect(result.state.sessions.twitch.status).toBe("idle");
    expect(result.state.sessions.twitch.tabId).toBeUndefined();
  });

  it("marks claimed rewards and emits scheduler events", async () => {
    const ready = campaign("drops", { rewards: [reward("claimable")] });
    const twitch = adapter("twitch", [ready], [channel("allowed")]);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.campaigns.twitch[0].rewards[0].status).toBe("claimed");
    expect(result.events).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "reward_claimed",
      data: expect.objectContaining({ method: "automatic" }),
    }));
  });

  it("isolates adapter failures per platform", async () => {
    const twitch = adapter("twitch", [], []);
    vi.mocked(twitch.discoverCampaigns).mockRejectedValue(new Error("Twitch unavailable"));
    const kickCandidate = { ...channel("kicklive"), platform: "kick" as const, url: "https://kick.com/kicklive" };
    const kick = adapter("kick", [campaign("kick-drops", { platform: "kick" })], [kickCandidate]);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings(),
      { twitch, kick },
    );

    expect(result.state.sessions.twitch.status).toBe("error");
    expect(result.state.sessions.twitch.errorChecks).toBe(1);
    expect(result.state.sessions.twitch.retryAfter).toBeDefined();
    expect(result.state.sessions.kick.status).toBe("watching");
    expect(result.events.some((event) => event.platform === "twitch" && event.level === "error")).toBe(true);
  });

  it("uses Idle Watchlist fallback when drop discovery fails and idle watchlist channels exist", async () => {
    const twitch = adapter("twitch", [], []);
    vi.mocked(twitch.discoverCampaigns).mockRejectedValue(new Error("Twitch drops unavailable"));
    vi.mocked(twitch.checkChannel).mockResolvedValue({
      live: true,
      categoryMatches: true,
      candidate: channel("fallback"),
    });

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: ["fallback"] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.readProgress).not.toHaveBeenCalled();
    expect(twitch.prepareWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ username: "fallback", live: true }),
      expect.any(Object),
      {},
    );
    expect(result.state.sessions.twitch).toMatchObject({
      status: "watching",
      channel: expect.objectContaining({ username: "fallback" }),
      errorChecks: 0,
      retryAfter: undefined,
    });
    expect(result.events.some((event) => event.category === "diagnostic" && event.level === "warn" && event.message.includes("checking Idle Watchlist fallback"))).toBe(true);
  });

  it("keeps previously discovered campaigns when discovery fails and the Idle Watchlist takes over", async () => {
    const known = campaign("known-drops");
    const twitch = adapter("twitch", [], []);
    vi.mocked(twitch.discoverCampaigns).mockRejectedValue(new Error("Twitch drops unavailable"));
    vi.mocked(twitch.checkChannel).mockResolvedValue({
      live: true,
      categoryMatches: true,
      candidate: channel("fallback"),
    });

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [known], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: ["fallback"] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.campaigns.twitch).toEqual([known]);
    expect(result.state.sessions.twitch).toMatchObject({
      status: "watching",
      channel: expect.objectContaining({ username: "fallback" }),
      campaignId: undefined,
    });
    expect(result.events.some((event) => event.category === "diagnostic" && event.level === "warn" && event.message.includes("checking Idle Watchlist fallback"))).toBe(true);
  });

  it("keeps previously discovered campaigns when discovery fails without idle watchlist channels", async () => {
    const known = campaign("known-drops");
    const twitch = adapter("twitch", [], []);
    vi.mocked(twitch.discoverCampaigns).mockRejectedValue(new Error("Twitch drops unavailable"));

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [known], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(result.state.campaigns.twitch).toEqual([known]);
    expect(result.state.sessions.twitch.status).toBe("error");
  });

  it("backs off failed platforms until their retry time", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("allowed")]);
    const retryAfter = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: {
            platform: "twitch",
            status: "error",
            offlineChecks: 0,
            errorChecks: 2,
            retryAfter,
            message: "Twitch unavailable",
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(result.state.sessions.twitch.retryAfter).toBe(retryAfter);
    expect(result.events.some((event) => event.category === "diagnostic" && event.message.includes("Waiting until"))).toBe(true);
  });

  it("clears platform backoff after a successful retry", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("allowed")]);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: {
            platform: "twitch",
            status: "error",
            offlineChecks: 0,
            errorChecks: 2,
            retryAfter: "2020-01-01T00:00:00.000Z",
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.discoverCampaigns).toHaveBeenCalled();
    expect(result.state.sessions.twitch.status).toBe("watching");
    expect(result.state.sessions.twitch.errorChecks).toBe(0);
    expect(result.state.sessions.twitch.retryAfter).toBeUndefined();
  });

  it("claims channel points for active watch sessions when supported", async () => {
    const twitch = {
      ...adapter("twitch", [campaign("drops")], [channel("allowed")]),
      claimChannelPoints: vi.fn(async () => true),
    };

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.claimChannelPoints).toHaveBeenCalledWith(expect.objectContaining({ username: "allowed" }));
    expect(result.events.some((event) => event.category === "diagnostic" && event.message.includes("Claimed channel points"))).toBe(true);
  });

  it("claims Kick challenges even when the platform never starts watching", async () => {
    const kick = {
      ...adapter("kick", [], []),
      claimChallenges: vi.fn(async () => [{ id: "daily", rarity: "epic", recurrence: "daily" }]),
    };

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: false }, kick: { enabled: true } } }),
      { twitch: adapter("twitch", [], []), kick },
    );

    expect(kick.claimChallenges).toHaveBeenCalled();
    expect(result.state.sessions.kick.status).toBe("idle");
    expect(result.state.gamification?.kick?.lastCheckedAt).toBeDefined();
    expect(result.events.some((event) => event.category === "activity" && event.code === "challenge_claimed")).toBe(true);
  });

  it("skips the Kick challenge poll inside the throttle window", async () => {
    const kick = { ...adapter("kick", [], []), claimChallenges: vi.fn(async () => []) };
    const recent = new Date(Date.now() - 60_000).toISOString();

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        gamification: { kick: { lastCheckedAt: recent } },
      },
      settings({ platform: { twitch: { enabled: false }, kick: { enabled: true } } }),
      { twitch: adapter("twitch", [], []), kick },
    );

    expect(kick.claimChallenges).not.toHaveBeenCalled();
    expect(result.state.gamification?.kick?.lastCheckedAt).toBe(recent);
  });

  // A clock rollback (NTP correction, a suspended VM) can leave a stamp in the
  // future. Treating it as "recently polled" would suppress claiming until the
  // clock caught up, so a future stamp counts as stale instead.
  it("polls immediately when the stored Kick challenge timestamp is in the future", async () => {
    const kick = { ...adapter("kick", [], []), claimChallenges: vi.fn(async () => []) };
    const future = new Date(Date.now() + 60 * 60_000).toISOString();

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
        gamification: { kick: { lastCheckedAt: future } },
      },
      settings({ platform: { twitch: { enabled: false }, kick: { enabled: true } } }),
      { twitch: adapter("twitch", [], []), kick },
    );

    expect(kick.claimChallenges).toHaveBeenCalled();
    expect(result.state.gamification?.kick?.lastCheckedAt).not.toBe(future);
  });

  it("does not claim Kick challenges when the setting is off", async () => {
    const kick = { ...adapter("kick", [], []), claimChallenges: vi.fn(async () => []) };

    await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: false }, kick: { enabled: true, autoClaimChallenges: false } } }),
      { twitch: adapter("twitch", [], []), kick },
    );

    expect(kick.claimChallenges).not.toHaveBeenCalled();
  });

  it("keeps the tick healthy when a Kick challenge poll throws", async () => {
    const kick = {
      ...adapter("kick", [], []),
      claimChallenges: vi.fn(async () => { throw new Error("gamification down"); }),
    };

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ platform: { twitch: { enabled: false }, kick: { enabled: true } } }),
      { twitch: adapter("twitch", [], []), kick },
    );

    expect(result.state.sessions.kick.status).not.toBe("error");
    expect(result.state.sessions.kick.errorChecks).toBe(0);
    expect(result.events.some((event) => event.category === "diagnostic" && event.level === "warn" && event.message.includes("gamification down"))).toBe(true);
  });

  it("suspends without backoff when a challenge reports an authentication failure", async () => {
    const kick = {
      ...adapter("kick", [], []),
      claimChallenges: vi.fn(async () => {
        throw new SafeFetchError({ kind: "security_policy_blocked", status: 403, reference: "safe-ref" });
      }),
    };

    const result = await runSchedulerTick(
      {
        ...baseState,
        sessions: {
          ...baseState.sessions,
          kick: { platform: "kick", status: "idle", offlineChecks: 0, errorChecks: 2 },
        },
      },
      settings({ platform: { twitch: { enabled: false }, kick: { enabled: true } } }),
      { twitch: adapter("twitch", [], []), kick },
      { platforms: ["kick"] },
    );

    expect(result.state.authHealth.kick).toMatchObject({
      status: "blocked",
      reasonCode: "security_policy_blocked",
      message: { values: { reference: "safe-ref" } },
    });
    expect(result.state.sessions.kick).toMatchObject({
      status: "paused",
      reasonCode: "authentication_unhealthy",
      errorChecks: 2,
      retryAfter: undefined,
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      category: "activity",
      code: "auth_health_changed",
      data: expect.objectContaining({ to: "blocked" }),
    }));
  });

  it("keeps transient platform failures on ordinary backoff", async () => {
    const kick = adapter("kick", [], []);
    vi.mocked(kick.discoverCampaigns).mockRejectedValueOnce(
      new SafeFetchError({ kind: "http_error", status: 503 }),
    );

    const result = await runSchedulerTick(
      baseState,
      settings({ platform: { twitch: { enabled: false }, kick: { enabled: true } } }),
      { twitch: adapter("twitch", [], []), kick },
      { platforms: ["kick"] },
    );

    expect(result.state.authHealth.kick.status).toBe("healthy");
    expect(result.state.sessions.kick).toMatchObject({
      status: "error",
      reasonCode: "platform_error",
      errorChecks: 1,
    });
    expect(result.state.sessions.kick.retryAfter).toBeDefined();
  });

  it("does not turn an authentication failure into an Idle Watchlist session", async () => {
    const kick = adapter("kick", [], []);
    vi.mocked(kick.discoverCampaigns).mockRejectedValueOnce(
      new SafeFetchError({ kind: "authentication_rejected", status: 401 }),
    );

    const result = await runSchedulerTick(
      baseState,
      settings({
        platform: {
          twitch: { enabled: false },
          kick: { enabled: true, idleWatchlistChannels: ["public-creator"] },
        },
      }),
      { twitch: adapter("twitch", [], []), kick },
      { platforms: ["kick"] },
    );

    expect(kick.listCandidateChannels).not.toHaveBeenCalled();
    expect(kick.checkChannel).not.toHaveBeenCalled();
    expect(result.state.sessions.kick).toMatchObject({
      status: "paused",
      reasonCode: "authentication_unhealthy",
      retryAfter: undefined,
    });
  });

  it("forgets managed page-context state when authentication cleanup fails", async () => {
    const stopPageContextTabs = vi.fn(async () => {
      throw new Error("tab close failed");
    });
    const managedContext = {
      platform: "kick" as const,
      tabId: 91,
      originUrl: "https://kick.com/drops/inventory",
      origin: "https://kick.com",
      ownedByExtension: true as const,
      muteFarmingTabs: true,
      keepFarmingVideosUnmuted: false,
      autoCloseFinishedDrops: true,
      adFocusMode: "off" as const,
      languageOverride: "auto" as const,
    };

    const result = await runSchedulerTick(
      {
        ...baseState,
        authHealth: {
          ...HEALTHY_AUTH,
          kick: { status: "invalid_credentials", reasonCode: "credentials_rejected" },
        },
        managedPageContextTabs: { kick: managedContext },
      },
      settings({ platform: { twitch: { enabled: false }, kick: { enabled: true } } }),
      { twitch: adapter("twitch", [], []), kick: adapter("kick", [], []) },
      { platforms: ["kick"], stopPageContextTabs },
    );

    expect(result.state.managedPageContextTabs?.kick).toBeUndefined();
    expect(result.events).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      level: "warn",
      message: "tab close failed",
    }));
  });
});

describe("scheduler tabless mode", () => {
  function tablessAdapter(campaigns: DropCampaign[], candidates: ChannelCandidate[]): PlatformAdapter {
    return { ...adapter("twitch", campaigns, candidates), supportsTabless: true };
  }

  it("does not open a watch tab and marks the session tabless when tabless mode is on", async () => {
    const twitch = tablessAdapter([campaign("drops")], [channel("creator")]);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ tablessMode: true, platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(result.state.sessions.twitch.status).toBe("watching");
    expect(result.state.sessions.twitch.watchMode).toBe("tabless");
    expect(result.state.sessions.twitch.tabId).toBeUndefined();
    expect(result.state.managedWatchTabs?.twitch).toBeUndefined();
  });

  it("falls back to a watch tab after the tabless heartbeat keeps failing", async () => {
    const twitch = tablessAdapter([campaign("drops")], [channel("creator")]);
    vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: channel("creator") });

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: channel("creator"),
            campaignId: "drops",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
            watchMode: "tabless",
            heartbeatChecks: 3,
            lastHeartbeatOk: false,
            lastHeartbeatAt: new Date().toISOString(),
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [campaign("drops")], kick: [] },
      },
      settings({ offlineRetryLimit: 3, tablessMode: true, platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.prepareWatchTab).toHaveBeenCalledTimes(1);
    expect(result.state.sessions.twitch.watchMode).toBe("tab");
    expect(result.state.sessions.twitch.tablessFallback).toBe(true);
  });

  it("stays tabless while heartbeats remain healthy on the same channel", async () => {
    const twitch = tablessAdapter([campaign("drops")], [channel("creator")]);
    vi.mocked(twitch.checkChannel).mockResolvedValue({ live: true, categoryMatches: true, candidate: channel("creator") });

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: channel("creator"),
            campaignId: "drops",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
            watchMode: "tabless",
            heartbeatChecks: 0,
            lastHeartbeatOk: true,
            lastHeartbeatAt: new Date().toISOString(),
          },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [campaign("drops")], kick: [] },
      },
      settings({ tablessMode: true, platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(result.state.sessions.twitch.watchMode).toBe("tabless");
  });

  it("uses a watch tab when tabless mode is off (default behavior)", async () => {
    const twitch = tablessAdapter([campaign("drops")], [channel("creator")]);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      settings({ tablessMode: false, platform: { twitch: { enabled: true, idleWatchlistChannels: [] }, kick: { enabled: false, idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
    );

    expect(twitch.prepareWatchTab).toHaveBeenCalledTimes(1);
    expect(result.state.sessions.twitch.watchMode).toBe("tab");
  });
});

describe("scheduler critical health observations", () => {
  const healthState: SchedulerState = {
    authHealth: HEALTHY_AUTH,
    sessions: {
      twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
      kick: { platform: "kick", status: "idle", offlineChecks: 0 },
    },
    campaigns: { twitch: [], kick: [] },
  };

  const healthSettings = (patch: SettingsPatch = {}): ExtensionSettings => settings({
    ...patch,
    platform: {
      twitch: { enabled: true, idleWatchlistChannels: ["fallback"], ...patch.platform?.twitch },
      kick: { enabled: false, idleWatchlistChannels: [], ...patch.platform?.kick },
    },
  });

  function failingAdapter(): PlatformAdapter {
    const twitch = adapter("twitch", [], [channel("fallback")]);
    vi.mocked(twitch.discoverCampaigns).mockRejectedValue(new SafeFetchError({ kind: "http_error", status: 503 }));
    return twitch;
  }

  it("records a failing tick when discovery throws", async () => {
    const twitch = failingAdapter();
    const result = await runSchedulerTick(
      healthState,
      healthSettings(),
      { twitch, kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    expect(result.state.criticalHealth?.twitch?.failingTicks).toBe(1);
    expect(result.state.criticalHealth?.twitch?.records.at(-1)?.kind).toBe("api_error");
    expect(result.state.criticalHealth?.twitch?.records.at(-1)).toMatchObject({
      platform: "twitch",
      code: "http_error",
      status: 503,
    });
    expect(result.state.criticalHealth?.twitch?.lastObservedAt).toBeDefined();
  });

  it("does not track anything when the prompt is disabled", async () => {
    const twitch = failingAdapter();
    const result = await runSchedulerTick(
      healthState,
      healthSettings({ criticalFailurePromptEnabled: false }),
      { twitch, kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    expect(result.state.criticalHealth?.twitch).toBeUndefined();
  });

  it("clears the failing counters after a healthy tick", async () => {
    const tickSettings = healthSettings();
    const first = await runSchedulerTick(
      healthState,
      tickSettings,
      { twitch: failingAdapter(), kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );
    expect(first.state.criticalHealth?.twitch?.failingTicks).toBe(1);

    const second = await runSchedulerTick(
      first.state,
      tickSettings,
      { twitch: adapter("twitch", [campaign("drops")], [channel("creator")]), kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    expect(second.state.criticalHealth?.twitch?.failingMs).toBe(0);
    expect(second.state.criticalHealth?.twitch?.failingTicks).toBe(0);
  });

  it("records the active reward's watched minutes on a healthy tick", async () => {
    const result = await runSchedulerTick(
      {
        ...healthState,
        sessions: {
          ...healthState.sessions,
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: channel("creator"),
            campaignId: "drops",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
          },
        },
      },
      healthSettings(),
      { twitch: adapter("twitch", [campaign("drops")], [channel("creator")]), kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    expect(result.state.criticalHealth?.twitch?.lastWatchedMinutes).toBe(20);
  });

  it("observes every platform on every tick, including early exits", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("creator")]);
    const result = await runSchedulerTick(
      {
        ...healthState,
        sessions: {
          ...healthState.sessions,
          twitch: {
            platform: "twitch",
            status: "error",
            offlineChecks: 0,
            errorChecks: 3,
            retryAfter: "2099-01-01T00:00:00.000Z",
          },
        },
      },
      healthSettings(),
      { twitch, kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    // The backoff branch exits the platform iteration early; the detector must
    // still see this tick, otherwise the churn window never drains.
    expect(twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(result.state.criticalHealth?.twitch?.lastObservedAt).toBeDefined();
    expect(result.state.criticalHealth?.twitch?.failingTicks).toBe(1);
    expect(result.state.criticalHealth?.twitch?.records.at(-1)).toMatchObject({
      kind: "api_error",
      code: "platform_backoff",
    });
  });

  it("records a failing tick when discovery throws and there is no idle watchlist", async () => {
    const twitch = failingAdapter();
    const result = await runSchedulerTick(
      healthState,
      healthSettings({ platform: { twitch: { idleWatchlistChannels: [] } } }),
      { twitch, kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    expect(result.state.sessions.twitch.reasonCode).toBe("platform_error");
    expect(result.state.criticalHealth?.twitch?.failingTicks).toBe(1);
    expect(result.state.criticalHealth?.twitch?.records.at(-1)).toMatchObject({
      kind: "api_error",
      code: "http_error",
      status: 503,
    });
  });

  it("records a failing tick when the watch phase throws after a successful discovery", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("creator")]);
    vi.mocked(twitch.checkChannel).mockRejectedValue(new Error("channel lookup exploded"));

    const result = await runSchedulerTick(
      {
        ...healthState,
        criticalHealth: { twitch: { ...DEFAULT_CRITICAL_HEALTH, failingMs: 2_000_000, failingTicks: 5 } },
      },
      healthSettings(),
      { twitch, kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    expect(twitch.discoverCampaigns).toHaveBeenCalled();
    expect(result.state.sessions.twitch.reasonCode).toBe("platform_error");
    // The accrual observation set before the throw must not survive as a healthy tick.
    expect(result.state.criticalHealth?.twitch?.failingTicks).toBe(6);
    expect(result.state.criticalHealth?.twitch?.failingMs).toBeGreaterThanOrEqual(2_000_000);
    expect(result.state.criticalHealth?.twitch?.records.at(-1)).toMatchObject({
      kind: "api_error",
      code: "unknown_error",
      detail: "channel lookup exploded",
    });
  });

  it.each([
    ["platform disabled", () => healthSettings({ platform: { twitch: { enabled: false } } })],
    ["automation stopped", () => healthSettings({ running: false })],
  ])("prunes the tab churn window on the %s early exit", async (_name, tickSettings) => {
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = await runSchedulerTick(
      {
        ...healthState,
        criticalHealth: {
          twitch: {
            ...DEFAULT_CRITICAL_HEALTH,
            managedTabOpens: [stale, stale, stale, stale, stale],
            breakerOpen: true,
          },
        },
      },
      tickSettings(),
      { twitch: adapter("twitch", [], []), kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    expect(result.state.criticalHealth?.twitch?.managedTabOpens).toEqual([]);
    expect(result.state.criticalHealth?.twitch?.breakerOpen).toBe(false);
    expect(result.state.criticalHealth?.twitch?.lastObservedAt).toBeDefined();
  });

  it("prunes the tab churn window while authentication is unhealthy", async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = await runSchedulerTick(
      {
        ...healthState,
        authHealth: { ...HEALTHY_AUTH, twitch: { status: "invalid_credentials", reasonCode: "credentials_rejected" } },
        criticalHealth: {
          twitch: {
            ...DEFAULT_CRITICAL_HEALTH,
            managedTabOpens: [stale, stale, stale, stale, stale],
            breakerOpen: true,
          },
        },
      },
      healthSettings(),
      { twitch: adapter("twitch", [], []), kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    expect(result.state.sessions.twitch.reasonCode).toBe("authentication_unhealthy");
    expect(result.state.criticalHealth?.twitch?.breakerOpen).toBe(false);
  });

  it("does not charge a failing tick for an outage that ends in an accrual precondition break", async () => {
    // Discovery fails (a failing observation) but the tick then finds the idle
    // watchlist channel it was watching has been superseded — an explainable
    // stop, so the precondition arm must win and clear the counters.
    const twitch = failingAdapter();
    const result = await runSchedulerTick(
      {
        ...healthState,
        sessions: {
          ...healthState.sessions,
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: channel("creator"),
            offlineChecks: 0,
          },
        },
        criticalHealth: { twitch: { ...DEFAULT_CRITICAL_HEALTH, failingMs: 2_000_000, failingTicks: 5 } },
      },
      healthSettings(),
      { twitch, kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    expect(result.state.sessions.twitch.reasonCode).toBe("higher_priority_idle_watchlist");
    expect(result.state.criticalHealth?.twitch?.failingTicks).toBe(0);
    expect(result.state.criticalHealth?.twitch?.failingMs).toBe(0);
  });

  it("resets the failing counters when an accrual precondition breaks", async () => {
    const tickSettings = healthSettings({ offlineRetryLimit: 1 });
    const first = await runSchedulerTick(
      healthState,
      tickSettings,
      { twitch: failingAdapter(), kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );
    expect(first.state.criticalHealth?.twitch?.failingTicks).toBe(1);

    const offline = adapter("twitch", [campaign("drops")], [channel("other")]);
    vi.mocked(offline.checkChannel).mockImplementation(async (candidate) => ({
      live: candidate.username !== "creator",
      categoryMatches: true,
      candidate,
    }));
    const second = await runSchedulerTick(
      {
        ...first.state,
        sessions: {
          ...first.state.sessions,
          twitch: {
            platform: "twitch",
            status: "watching",
            channel: channel("creator"),
            campaignId: "drops",
            rewardId: "reward-in_progress",
            offlineChecks: 0,
          },
        },
      },
      tickSettings,
      { twitch: offline, kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    expect(second.state.sessions.twitch.reasonCode).toBe("channel_offline");
    expect(second.state.criticalHealth?.twitch?.failingTicks).toBe(0);
    expect(second.state.criticalHealth?.twitch?.failingMs).toBe(0);
  });
});

describe("scheduler managed tab circuit breaker", () => {
  const openBreakerHealth = () => ({
    ...DEFAULT_CRITICAL_HEALTH,
    breakerOpen: true,
    managedTabOpens: Array.from({ length: TAB_CHURN_LIMIT }, (_unused, index) =>
      new Date(Date.now() - index * 1000).toISOString()),
  });

  const breakerSettings = (patch: SettingsPatch = {}): ExtensionSettings => settings({
    ...patch,
    platform: {
      twitch: { enabled: true, idleWatchlistChannels: [], ...patch.platform?.twitch },
      kick: { enabled: false, idleWatchlistChannels: [], ...patch.platform?.kick },
    },
  });

  const watchingState = (): SchedulerState => ({
    authHealth: HEALTHY_AUTH,
    sessions: {
      twitch: {
        platform: "twitch",
        status: "watching",
        channel: channel("creator"),
        campaignId: "drops",
        rewardId: "reward-in_progress",
        offlineChecks: 0,
        tabId: 42,
        tabManagedByExtension: true,
      },
      kick: { platform: "kick", status: "idle", offlineChecks: 0 },
    },
    campaigns: { twitch: [campaign("drops")], kick: [] },
    managedWatchTabs: {
      twitch: { platform: "twitch", tabId: 42, channelUrl: channel("creator").url, ownedByExtension: true },
    },
  });

  afterEach(() => {
    syncManagedTabBreakers({});
  });

  it("does not open a watch tab while the breaker is open", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("creator")]);

    const result = await runSchedulerTick(
      { ...watchingState(), criticalHealth: { twitch: openBreakerHealth() } },
      breakerSettings(),
      { twitch, kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    expect(twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(twitch.stopWatchTab).toHaveBeenCalled();
    expect(result.state.sessions.twitch.status).not.toBe("watching");
    expect(result.state.sessions.twitch.reasonCode).toBe("critical_failure");
    expect(result.state.managedWatchTabs?.twitch).toBeUndefined();
    expect(managedTabBreakerOpen("twitch")).toBe(true);
  });

  it("keeps ticking a breaker-paused platform so the breaker can release", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("creator")]);

    const result = await runSchedulerTick(
      { ...watchingState(), criticalHealth: { twitch: openBreakerHealth() } },
      breakerSettings(),
      { twitch, kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    // Without this observation the churn window never prunes and an unflagged
    // breaker would never close: farming would stall permanently.
    expect(result.state.criticalHealth?.twitch?.lastObservedAt).toBeDefined();
  });

  it("releases the breaker once the churn evidence ages out", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("creator")]);
    const stale = new Date(Date.now() - TAB_CHURN_WINDOW_MS - 60_000).toISOString();

    const result = await runSchedulerTick(
      {
        ...watchingState(),
        criticalHealth: {
          twitch: { ...DEFAULT_CRITICAL_HEALTH, breakerOpen: true, managedTabOpens: [stale, stale] },
        },
      },
      breakerSettings(),
      { twitch, kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    expect(result.state.criticalHealth?.twitch?.breakerOpen).toBe(false);
  });

  it("does not gate anything when the prompt is disabled", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("creator")]);

    const result = await runSchedulerTick(
      { ...watchingState(), criticalHealth: { twitch: openBreakerHealth() } },
      breakerSettings({ criticalFailurePromptEnabled: false }),
      { twitch, kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    expect(twitch.prepareWatchTab).toHaveBeenCalled();
    expect(result.state.sessions.twitch.status).toBe("watching");
  });

  it("records each newly created managed watch tab", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("creator")]);

    const result = await runSchedulerTick(
      {
        authHealth: HEALTHY_AUTH,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [], kick: [] },
      },
      breakerSettings(),
      { twitch, kick: adapter("kick", [], []) },
      { platforms: ["twitch"] },
    );

    expect(result.state.criticalHealth?.twitch?.managedTabOpens).toHaveLength(1);
    expect(result.state.criticalHealth?.twitch?.records.at(-1)?.kind).toBe("watch_tab_open");
  });

  it("does not record a reused managed watch tab", async () => {
    const twitch = adapter("twitch", [campaign("drops")], [channel("creator")]);
    const initial: SchedulerState = {
      authHealth: HEALTHY_AUTH,
      sessions: {
        twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
        kick: { platform: "kick", status: "idle", offlineChecks: 0 },
      },
      campaigns: { twitch: [], kick: [] },
    };

    const first = await runSchedulerTick(initial, breakerSettings(), { twitch, kick: adapter("kick", [], []) }, { platforms: ["twitch"] });
    expect(first.state.criticalHealth?.twitch?.managedTabOpens).toHaveLength(1);

    const second = await runSchedulerTick(first.state, breakerSettings(), { twitch, kick: adapter("kick", [], []) }, { platforms: ["twitch"] });

    expect(second.state.criticalHealth?.twitch?.managedTabOpens).toHaveLength(1);
  });
});
