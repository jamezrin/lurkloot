import { describe, expect, it } from "vitest";
import {
  campaignFarmingBlockers,
  evaluateCampaignFarming,
  rewardsInFarmingScope,
} from "@lurkloot/shared/campaignFarming";
import type {
  DropCampaign,
  ExtensionSettings,
  PlatformSettings,
  RewardFilter,
} from "@lurkloot/shared/models";
import { defaultRewardFilter } from "@lurkloot/shared/rewardFilter";
import { mergeSettings } from "@lurkloot/shared/settings";
import { rewardKindCounts } from "../../popup-ui/src/viewModels";

const NOW = Date.parse("2026-08-15T10:00:00.000Z");

function settings(
  overrides: Partial<ExtensionSettings> = {},
  twitch: Partial<PlatformSettings> = {},
): ExtensionSettings {
  const base = mergeSettings(undefined);
  const platform = overrides.platform ?? base.platform;
  return {
    ...base,
    ...overrides,
    platform: { ...platform, twitch: { ...platform.twitch, ...twitch } },
  };
}

function campaign(overrides: Partial<DropCampaign> = {}): DropCampaign {
  return {
    id: "campaign",
    platform: "twitch",
    name: "Campaign",
    status: "active",
    accountLinked: true,
    rewards: [
      {
        id: "reward",
        name: "Reward",
        requiredMinutes: 60,
        watchedMinutes: 0,
        status: "locked",
        requirement: "watch",
        isWatchBased: true,
      },
    ],
    connectionUrls: [],
    ...overrides,
  };
}

describe("evaluateCampaignFarming", () => {
  it.each([
    ["excluded", campaign(), settings({ excludedCampaignIds: ["campaign"] })],
    ["upcoming", campaign({ status: "upcoming" }), settings()],
    ["expired", campaign({ status: "expired" }), settings()],
    ["completed", campaign({ status: "completed" }), settings()],
    ["no_rewards", campaign({ rewards: [] }), settings()],
  ] as const)("returns %s for a rejected campaign", (code, source, currentSettings) => {
    expect(evaluateCampaignFarming(source, currentSettings, { now: NOW })).toMatchObject({
      farmable: false,
      code,
    });
  });

  it("farms an unlinked Twitch watch campaign with inventory progress when enabled", () => {
    const source = campaign({
      accountLinked: false,
      eligibility: "account_not_linked",
      rewards: [{ ...campaign().rewards[0]!, watchedMinutes: 1, status: "in_progress" }],
    });
    expect(evaluateCampaignFarming(source, settings(), { now: NOW })).toEqual({ farmable: true });
    const disabled = settings({}, { farmUnlinkedCampaigns: false });
    expect(evaluateCampaignFarming(source, disabled, { now: NOW })).toMatchObject({
      farmable: false,
      code: "unlinked_campaigns_disabled",
    });
  });

  it("distinguishes a disabled unlinked class from Twitch's platform requirement", () => {
    const currentSettings = settings();
    currentSettings.platform.kick = {
      ...currentSettings.platform.kick,
      farmUnlinkedCampaigns: false,
    };
    expect(
      evaluateCampaignFarming(
        campaign({ platform: "kick", accountLinked: false }),
        currentSettings,
        { now: NOW },
      ),
    ).toMatchObject({ farmable: false, code: "unlinked_campaigns_disabled" });
  });

  it("returns category_filtered before inspecting rewards in include mode", () => {
    const currentSettings = settings();
    currentSettings.platform.twitch = {
      ...currentSettings.platform.twitch,
      categoryMode: "include",
      categories: [{ id: "other", name: "Other" }],
    };
    expect(
      evaluateCampaignFarming(campaign({ categoryId: "game" }), currentSettings, { now: NOW }),
    ).toMatchObject({ farmable: false, code: "category_filtered" });
  });

  it("returns category_blocked for a blocked game, in either mode", () => {
    const currentSettings = settings();
    currentSettings.platform.twitch = {
      ...currentSettings.platform.twitch,
      blockedCategories: [{ id: "game", name: "Game" }],
    };
    expect(
      evaluateCampaignFarming(campaign({ categoryId: "game" }), currentSettings, { now: NOW }),
    ).toMatchObject({ farmable: false, code: "category_blocked" });
    expect(
      evaluateCampaignFarming(campaign({ categoryId: "other" }), currentSettings, { now: NOW }),
    ).toEqual({ farmable: true });

    currentSettings.platform.twitch = {
      ...currentSettings.platform.twitch,
      categoryMode: "include",
      categories: [{ id: "game", name: "Game" }],
    };
    expect(
      evaluateCampaignFarming(campaign({ categoryId: "game" }), currentSettings, { now: NOW }),
    ).toMatchObject({ farmable: false, code: "category_blocked" });
  });

  it("farms everything when nothing is blocked", () => {
    const currentSettings = settings();
    currentSettings.platform.twitch = { ...currentSettings.platform.twitch, blockedCategories: [] };
    expect(
      evaluateCampaignFarming(campaign({ categoryId: "game" }), currentSettings, { now: NOW }),
    ).toEqual({ farmable: true });
  });

  it("returns not_pinned only when the pinned-only switch is evaluated", () => {
    const currentSettings = settings({}, { farmPinnedOnly: true });
    expect(
      evaluateCampaignFarming(campaign(), currentSettings, { now: NOW, includePinnedOnly: true }),
    ).toMatchObject({ farmable: false, code: "not_pinned" });
    expect(evaluateCampaignFarming(campaign(), currentSettings, { now: NOW })).toEqual({
      farmable: true,
    });
  });

  it("never lets a pin rescue a campaign eligibility already rejected", () => {
    const currentSettings = settings({ campaignPins: ["campaign"] }, { farmPinnedOnly: true });
    currentSettings.platform.twitch = {
      ...currentSettings.platform.twitch,
      blockedCategories: [{ id: "game", name: "Game" }],
    };
    expect(
      evaluateCampaignFarming(campaign({ categoryId: "game" }), currentSettings, {
        now: NOW,
        includePinnedOnly: true,
      }),
    ).toMatchObject({ farmable: false, code: "category_blocked" });
  });

  it.each([
    ["reward_prerequisites_unmet", { preconditionsMet: false }],
    ["reward_not_started", { availableFrom: "2026-08-15T11:00:00.000Z" }],
    ["reward_window_ended", { availableUntil: "2026-08-15T09:00:00.000Z" }],
  ] as const)("returns %s with reward context", (code, rewardOverrides) => {
    const source = campaign({ rewards: [{ ...campaign().rewards[0]!, ...rewardOverrides }] });
    expect(evaluateCampaignFarming(source, settings(), { now: NOW })).toMatchObject({
      farmable: false,
      code,
      rewardId: "reward",
      rewardName: "Reward",
    });
  });

  it("returns insufficient_time with actionable deadline context", () => {
    const source = campaign({
      endsAt: "2026-08-15T10:30:00.000Z",
      rewards: [{ ...campaign().rewards[0]!, requiredMinutes: 60, watchedMinutes: 10 }],
    });
    expect(evaluateCampaignFarming(source, settings(), { now: NOW })).toEqual({
      farmable: false,
      code: "insufficient_time",
      rewardId: "reward",
      rewardName: "Reward",
      deadline: "2026-08-15T10:30:00.000Z",
      remainingMinutes: 50,
      availableMinutes: 30,
      marginMinutes: 5,
    });
  });

  it("returns farmable when any reward can currently be earned", () => {
    expect(evaluateCampaignFarming(campaign(), settings(), { now: NOW })).toEqual({
      farmable: true,
    });
  });
});

describe("campaignFarmingBlockers (#677)", () => {
  const subscription = {
    id: "sub",
    name: "Sub badge",
    requiredMinutes: 0,
    requiredSubs: 1,
    watchedMinutes: 0,
    status: "locked" as const,
    requirement: "subscription" as const,
  };

  it("lists each blocker a user meets in turn, ending at one no setting lifts", () => {
    const current = settings({ excludedCampaignIds: ["campaign"] }, { farmPinnedOnly: true });
    const blockers = campaignFarmingBlockers(campaign({ rewards: [subscription] }), current, {
      includePinnedOnly: true,
      now: NOW,
    });

    expect(blockers.map((blocker) => blocker.code)).toEqual([
      "excluded",
      "not_pinned",
      "subscription_required",
    ]);
    expect(blockers[0]).toEqual(
      evaluateCampaignFarming(campaign({ rewards: [subscription] }), current, {
        includePinnedOnly: true,
        now: NOW,
      }),
    );
  });

  it("stops once the campaign would be farmable", () => {
    const blockers = campaignFarmingBlockers(
      campaign(),
      settings({ excludedCampaignIds: ["campaign"] }),
      { now: NOW },
    );

    expect(blockers.map((blocker) => blocker.code)).toEqual(["excluded"]);
  });

  it("lifts an unfinishable-reward skip and ends there", () => {
    const tight = campaign({ endsAt: new Date(NOW + 10 * 60_000).toISOString() });
    const blockers = campaignFarmingBlockers(tight, settings({ skipUnfinishableRewards: true }), {
      now: NOW,
    });

    // With the skip off the reward is farmable again, so the chain stops.
    expect(blockers.map((blocker) => blocker.code)).toEqual(["insufficient_time"]);
  });

  it("is empty for a farmable campaign", () => {
    expect(campaignFarmingBlockers(campaign(), settings(), { now: NOW })).toEqual([]);
  });
});

describe("rewardFilter", () => {
  const filtered = (filter: Partial<RewardFilter>): ExtensionSettings =>
    settings({}, { rewardFilter: { ...defaultRewardFilter("twitch"), ...filter } });
  const watch = campaign().rewards[0]!;
  const badge = { ...watch, id: "badge", benefits: [{ id: "b", distributionType: "BADGE" }] };
  const subscription = {
    ...watch,
    id: "sub",
    requiredSubs: 1,
    requiredMinutes: 30,
    requirement: "subscription" as const,
    isWatchBased: false,
  };
  const scope = (source: DropCampaign, filter: Partial<RewardFilter>) =>
    rewardsInFarmingScope(source, { ...defaultRewardFilter("twitch"), ...filter }).map(
      (reward) => reward.id,
    );

  it("rejects a campaign with no reward of a selected kind, saying it was the kind", () => {
    expect(
      evaluateCampaignFarming(campaign(), filtered({ kinds: ["badge"] }), { now: NOW }),
    ).toEqual({ farmable: false, code: "reward_type_filtered", filteredBy: "kind" });
  });

  it("rejects a campaign whose kinds match but every one needs a skipped subscription", () => {
    expect(
      evaluateCampaignFarming(
        campaign({ rewards: [subscription] }),
        filtered({ subscriptions: "skip" }),
        { now: NOW },
      ),
    ).toEqual({ farmable: false, code: "reward_type_filtered", filteredBy: "subscription" });
  });

  it("farms the free rewards of a mixed campaign under skip", () => {
    const mixed = campaign({
      rewards: [
        { ...watch, id: "first" },
        { ...watch, id: "free", preconditionRewardIds: ["first"] },
        subscription,
      ],
    });
    expect(
      evaluateCampaignFarming(mixed, filtered({ subscriptions: "skip" }), { now: NOW }),
    ).toEqual({ farmable: true });
    expect(scope(mixed, { subscriptions: "skip" })).toEqual(["first", "free"]);
  });

  it("lifting a reward-filter rejection restores the platform default", () => {
    const blockers = campaignFarmingBlockers(campaign(), filtered({ kinds: ["badge"] }), {
      now: NOW,
    });
    expect(blockers).toEqual([
      { farmable: false, code: "reward_type_filtered", filteredBy: "kind" },
    ]);
    const kick = settings();
    kick.platform.kick = {
      ...kick.platform.kick,
      rewardFilter: { kinds: ["item"], subscriptions: "only" },
    };
    expect(
      campaignFarmingBlockers(campaign({ platform: "kick" }), kick, { now: NOW }).map(
        (blocker) => blocker.code,
      ),
    ).toEqual(["reward_type_filtered"]);
  });

  it("ends the blocker replay when the default filter misses too", () => {
    // Kick farms items only, so a badge-only reward misses its default filter;
    // lifting to that default must not loop.
    const badgeOnly = campaign({ platform: "kick", rewards: [badge] });
    expect(campaignFarmingBlockers(badgeOnly, settings(), { now: NOW })).toEqual([
      { farmable: false, code: "reward_type_filtered", filteredBy: "kind" },
    ]);
  });

  it("scopes the whole campaign under the default filter", () => {
    const source = campaign({ rewards: [watch, badge, subscription] });
    expect(scope(source, {})).toEqual(["reward", "badge", "sub"]);
  });

  it("is done with a campaign once its matching rewards are earned, others left or not", () => {
    const source = campaign({
      rewards: [{ ...badge, status: "claimed", watchedMinutes: 60 }, watch],
    });
    expect(
      evaluateCampaignFarming(source, filtered({ kinds: ["badge"] }), { now: NOW }),
    ).toMatchObject({ farmable: false, code: "reward_types_obtained" });
    expect(evaluateCampaignFarming(source, settings(), { now: NOW })).toEqual({ farmable: true });
  });

  it("reports a campaign without rewards as such rather than filtered", () => {
    expect(
      evaluateCampaignFarming(campaign({ rewards: [] }), filtered({ kinds: ["badge"] }), {
        now: NOW,
      }),
    ).toMatchObject({ farmable: false, code: "no_rewards" });
  });

  it("reads a stored filter per platform, normalizing what the platform lacks", () => {
    const platform = mergeSettings({
      platform: {
        twitch: { rewardFilter: { kinds: ["badge", "nope"], subscriptions: "skip" } },
        kick: { rewardFilter: { kinds: ["badge"], subscriptions: "bogus" } },
      },
    } as never).platform;
    expect(platform.twitch.rewardFilter).toEqual({ kinds: ["badge"], subscriptions: "skip" });
    expect(platform.kick.rewardFilter).toEqual(defaultRewardFilter("kick"));
  });
});

describe("rewardKindCounts", () => {
  const watch = campaign().rewards[0]!;
  const badge = { ...watch, id: "badge", benefits: [{ id: "b", distributionType: "BADGE" }] };
  const emote = { ...watch, id: "emote", benefits: [{ id: "e", distributionType: "EMOTE" }] };
  const subscription = {
    ...watch,
    id: "sub",
    requiredSubs: 1,
    requiredMinutes: 30,
    requirement: "subscription" as const,
    isWatchBased: false,
  };
  const withFilter = (filter: Partial<RewardFilter>, twitch: Partial<PlatformSettings> = {}) =>
    settings({}, { rewardFilter: { ...defaultRewardFilter("twitch"), ...filter }, ...twitch });

  it("counts what each kind alone would queue", () => {
    expect(
      rewardKindCounts(
        [
          campaign({ id: "item" }),
          campaign({ id: "badged", rewards: [badge] }),
          campaign({ id: "both", rewards: [watch, emote] }),
        ],
        // The current kinds do not matter: each count selects its kind alone.
        withFilter({ kinds: ["emote"] }),
        "twitch",
      ),
    ).toEqual({ item: 2, badge: 1, emote: 1 });
  });

  it("keeps the subscription mode and applies the user's subscription marks first", () => {
    const sources = [campaign({ id: "item" }), campaign({ id: "subbed", rewards: [subscription] })];
    // Skip leaves the unmarked subscription reward out.
    expect(rewardKindCounts(sources, withFilter({ subscriptions: "skip" }), "twitch")).toEqual({
      item: 1,
      badge: 0,
      emote: 0,
    });
    // Marked as subscribed, it passes skip and is farmed by watching.
    const marked = withFilter({ subscriptions: "skip" }, { subscribedRewardMarks: ["subbed:sub"] });
    expect(rewardKindCounts(sources, marked, "twitch")).toEqual({ item: 2, badge: 0, emote: 0 });
    // Only keeps nothing but the (marked) subscription reward.
    const only = withFilter({ subscriptions: "only" }, { subscribedRewardMarks: ["subbed:sub"] });
    expect(rewardKindCounts(sources, only, "twitch")).toEqual({ item: 1, badge: 0, emote: 0 });
  });

  it("counts only pins while farming pinned campaigns only", () => {
    const sources = [campaign({ id: "pinned" }), campaign({ id: "loose" })];
    const pinnedOnly = settings({ campaignPins: ["pinned"] }, { farmPinnedOnly: true });
    expect(rewardKindCounts(sources, pinnedOnly, "twitch").item).toBe(1);
  });

  it("counts nothing for kinds the platform cannot farm", () => {
    const kick = [
      campaign({ id: "k1", platform: "kick" }),
      campaign({ id: "k2", platform: "kick" }),
    ];
    expect(rewardKindCounts(kick, mergeSettings(undefined), "kick")).toEqual({
      item: 2,
      badge: 0,
      emote: 0,
    });
  });
});
