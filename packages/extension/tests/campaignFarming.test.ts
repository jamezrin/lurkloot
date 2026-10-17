import { describe, expect, it } from "vitest";
import {
  campaignFarmingBlockers,
  evaluateCampaignFarming,
  rewardMatchesFarmTypes,
  rewardsInFarmingScope,
} from "@lurkloot/shared/campaignFarming";
import { farmRewardTypeCounts } from "../../popup-ui/src/viewModels";
import type { DropCampaign, ExtensionSettings, RewardFarmType } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";

const NOW = Date.parse("2026-08-15T10:00:00.000Z");

function settings(overrides: Partial<ExtensionSettings> = {}): ExtensionSettings {
  const base = mergeSettings(undefined);
  return {
    ...base,
    ...overrides,
    platform: overrides.platform ?? base.platform,
    farmingEligibility: overrides.farmingEligibility ?? base.farmingEligibility,
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
    const disabled = settings();
    disabled.farmingEligibility.farmUnlinkedCampaigns = false;
    expect(evaluateCampaignFarming(source, disabled, { now: NOW })).toMatchObject({
      farmable: false,
      code: "unlinked_campaigns_disabled",
    });
  });

  it("distinguishes a disabled unlinked class from Twitch's platform requirement", () => {
    const currentSettings = settings({
      farmingEligibility: {
        farmUnlinkedCampaigns: false,
        farmSubscriptionCampaigns: true,
      },
    });
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
    const currentSettings = settings({ farmPinnedOnly: true });
    expect(
      evaluateCampaignFarming(campaign(), currentSettings, { now: NOW, includePinnedOnly: true }),
    ).toMatchObject({ farmable: false, code: "not_pinned" });
    expect(evaluateCampaignFarming(campaign(), currentSettings, { now: NOW })).toEqual({
      farmable: true,
    });
  });

  it("never lets a pin rescue a campaign eligibility already rejected", () => {
    const currentSettings = settings({ farmPinnedOnly: true, campaignPins: ["campaign"] });
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
    const current = settings({ excludedCampaignIds: ["campaign"], farmPinnedOnly: true });
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

describe("farmRewardTypes (#731)", () => {
  const typed = (...types: string[]): ExtensionSettings =>
    mergeSettings({ platform: { twitch: { farmRewardTypes: types } } } as never);
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
  const scope = (source: DropCampaign, ...types: RewardFarmType[]) =>
    rewardsInFarmingScope(source, types).map((reward) => reward.id);

  it("judges single rewards, counting a marked subscription as still asked for", () => {
    const marked = { ...subscription, subscriptionMarked: true };
    expect(rewardMatchesFarmTypes(watch, ["no_subscription"])).toBe(true);
    expect(rewardMatchesFarmTypes(marked, ["no_subscription"])).toBe(false);
    expect(rewardMatchesFarmTypes(marked, ["subscription"])).toBe(true);
    expect(rewardMatchesFarmTypes(watch, ["badge"])).toBe(false);
    expect(rewardMatchesFarmTypes(badge, ["badge"])).toBe(true);
    expect(rewardMatchesFarmTypes(subscription, [])).toBe(true);
  });

  it("farms the watch rewards of a campaign that also has a subscription reward", () => {
    const mixed = campaign({ rewards: [watch, subscription] });
    expect(scope(mixed, "no_subscription")).toEqual(["reward"]);
    expect(scope(mixed, "subscription")).toEqual(["sub"]);
    expect(evaluateCampaignFarming(mixed, typed("no_subscription"), { now: NOW })).toEqual({
      farmable: true,
    });
  });

  it("combines selected types as any-of", () => {
    const source = campaign({ rewards: [watch, badge, { ...subscription, id: "paid" }] });
    expect(scope(source, "subscription", "badge")).toEqual(["badge", "paid"]);
    expect(scope(source, "no_subscription", "subscription")).toEqual(["reward", "badge", "paid"]);
    expect(scope(source)).toHaveLength(3);
  });

  it("keeps what a matching reward waits on", () => {
    const source = campaign({
      rewards: [
        { ...watch, id: "first" },
        { ...badge, preconditionRewardIds: ["first"] },
        { ...watch, id: "unrelated" },
      ],
    });
    expect(scope(source, "badge")).toEqual(["first", "badge"]);
  });

  it("skips a campaign with no reward of the types, and lifts that to every type", () => {
    expect(evaluateCampaignFarming(campaign(), typed("badge"), { now: NOW })).toMatchObject({
      farmable: false,
      code: "reward_type_filtered",
    });
    expect(campaignFarmingBlockers(campaign(), typed("badge"), { now: NOW })).toHaveLength(1);
  });

  it("is done with a campaign once its matching rewards are earned, others left or not", () => {
    const source = campaign({
      rewards: [{ ...badge, status: "claimed", watchedMinutes: 60 }, watch],
    });
    expect(evaluateCampaignFarming(source, typed("badge"), { now: NOW })).toMatchObject({
      farmable: false,
      code: "reward_types_obtained",
    });
    expect(evaluateCampaignFarming(source, settings(), { now: NOW })).toEqual({ farmable: true });
  });

  it("reads stored types, dropping unknown ones and badges on Kick", () => {
    const stored = (twitch: unknown, kick: unknown) =>
      mergeSettings({
        platform: { twitch: { farmRewardTypes: twitch }, kick: { farmRewardTypes: kick } },
      } as never).platform;
    expect(stored("badge", undefined).twitch.farmRewardTypes).toEqual([]);
    expect(stored(["badges", "badge", "badge"], []).twitch.farmRewardTypes).toEqual(["badge"]);
    expect(stored([], ["badge", "subscription"]).kick.farmRewardTypes).toEqual(["subscription"]);
  });

  it("counts what each Queue tab would farm on its own", () => {
    expect(
      farmRewardTypeCounts(
        [
          campaign({ id: "plain" }),
          campaign({ id: "badged", rewards: [watch, badge] }),
          campaign({ id: "sub", rewards: [watch, subscription] }),
        ],
        mergeSettings({}),
      ),
      // An unmarked subscription reward cannot be farmed by watching, so on its
      // own "Requires subscription" queues nothing here.
    ).toEqual({ all: 3, no_subscription: 3, subscription: 0, badge: 1 });
  });
});
