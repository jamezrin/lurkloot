import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DropCampaign, DropReward, WatchSession } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";
import { I18nContext } from "../../popup-ui/src/context";
import { DropsPanel } from "../../popup-ui/src/drops";
import {
  campaignFilterCategories,
  campaignStats,
  campaignViewFromCampaign,
  isCampaignVisible,
} from "../../popup-ui/src/viewModels";
import type { CampaignView, TFunction } from "../../popup-ui/src/types";

const idleSession: WatchSession = {
  platform: "twitch",
  offlineChecks: 0,
  status: "idle",
};

function reward(overrides: Partial<DropReward>): DropReward {
  return {
    id: "reward",
    name: "Reward",
    requiredMinutes: 0,
    watchedMinutes: 0,
    status: "locked",
    ...overrides,
  };
}

function campaign(id: string, rewards: DropReward[]): DropCampaign {
  return {
    id,
    platform: "twitch",
    name: id,
    status: "active",
    rewards,
  };
}

const testMessages: Record<string, string> = {
  actionRequired: "Action required",
  campaignLeft: "Campaign left",
  earned: "Earned",
  excluded: "Excluded",
  excludeFromFarming: "Exclude from farming",
  farmingLabel: "Farming",
  insufficientTimeRemaining: "Insufficient time remaining",
  left: "Left",
  notEarnableByWatching: "Not earnable by watching",
  nextReward: "Next: $1",
  qualifyingSubscriptionsRequired: "Requires $1 qualifying subscriptions",
  subscribedRefresh: "I've subscribed — refresh status",
  subscriptionProgressUnknown: "Progress unavailable",
  subscriptionRequired: "Subscription required",
};

const testT: TFunction = (key, substitutions) => {
  const message = testMessages[key] ?? key;
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  return values.reduce<string>((translated, value, index) => (
    value == null ? translated : translated.replace(`$${index + 1}`, value)
  ), message);
};

// The drops panel only auto-expands the campaign it is currently farming, so mark
// the view under test as farming to render its expanded body into static markup.
function expandedView(view: CampaignView): CampaignView {
  return { ...view, farmingChannel: { name: "test-channel" } };
}

function renderDrops(campaigns: CampaignView[], refreshing = false): string {
  return renderToStaticMarkup(createElement(
    I18nContext.Provider,
    { value: { t: testT, dir: "ltr", locale: "en" } },
    createElement(DropsPanel, {
      campaigns,
      gameMap: {},
      refreshing,
      onRefreshCampaign: () => {},
      onReorder: () => {},
      onToggleExclude: () => {},
    }),
  ));
}

describe("subscription drop popup views", () => {
  it("marks and explains watch rewards with insufficient time", () => {
    const source = {
      ...campaign("timed", [reward({ requirement: "watch", requiredMinutes: 60, watchedMinutes: 30, status: "in_progress" })]),
      endsAt: "2026-07-19T12:34:59.999Z",
    };

    const view = campaignViewFromCampaign(source, 0, idleSession, false, {
      skipUnfinishableRewards: true,
      deadlineSafetyMarginMinutes: 5,
      now: Date.parse("2026-07-19T12:00:00.000Z"),
    });

    expect(view.rewards[0].ineligibilityReason).toBe("insufficient_time");
    expect(renderDrops([expandedView(view)])).toContain("Insufficient time remaining");

    const disabled = campaignViewFromCampaign(source, 0, idleSession, false, {
      skipUnfinishableRewards: false,
      deadlineSafetyMarginMinutes: 5,
      now: Date.parse("2026-07-19T12:00:00.000Z"),
    });
    expect(disabled.rewards[0].ineligibilityReason).toBeUndefined();
  });

  it("preserves subscription rewards without fabricating progress", () => {
    const source = campaign("subscription-only", [
      reward({ id: "subscribe-once", name: "Subscribe once", requirement: "subscription", requiredSubs: 1 }),
      reward({ id: "subscribe-twice", name: "Subscribe twice", requirement: "subscription", requiredSubs: 2 }),
    ]);

    const view = campaignViewFromCampaign(source, 0, idleSession, false);

    expect(view.rewards).toHaveLength(2);
    expect(view.rewards[0]).toMatchObject({
      requirement: "subscription",
      requiredSubs: 1,
      progress: undefined,
    });
    expect(view.hasSubscriptionRewards).toBe(true);
    expect(view.hasWatchRewards).toBe(false);
    expect(campaignStats(view)).toMatchObject({
      kind: "subscription",
      totalRequired: 0,
      totalFarmed: 0,
      remaining: 0,
      progress: undefined,
      completed: 0,
      totalRewards: 2,
      complete: false,
    });
  });

  it("uses only watch rewards for mixed-campaign minute totals", () => {
    const source = campaign("mixed", [
      reward({ id: "watch", name: "Watch", requirement: "watch", requiredMinutes: 60, watchedMinutes: 30, status: "in_progress" }),
      reward({ id: "subscribe", name: "Subscribe", requirement: "subscription", requiredSubs: 1, status: "claimed" }),
    ]);

    const view = campaignViewFromCampaign(source, 0, idleSession, false);

    expect(view.rewards).toHaveLength(2);
    expect(view.rewards[1]).toMatchObject({ requirement: "subscription", progress: 100, obtained: true });
    expect(view.hasSubscriptionRewards).toBe(true);
    expect(view.hasWatchRewards).toBe(true);
    expect(campaignStats(view)).toMatchObject({
      kind: "mixed",
      totalRequired: 60,
      totalFarmed: 30,
      remaining: 30,
      progress: 50,
      completed: 1,
      totalRewards: 2,
      complete: false,
    });
  });

  it("separates next-reward time from total campaign time", () => {
    const source = campaign("sequential", [
      reward({ id: "reward-30", name: "30 minute reward", requirement: "watch", requiredMinutes: 30 }),
      reward({ id: "reward-60", name: "60 minute reward", requirement: "watch", requiredMinutes: 60 }),
      reward({ id: "reward-120", name: "120 minute reward", requirement: "watch", requiredMinutes: 120 }),
      reward({ id: "reward-240", name: "240 minute reward", requirement: "watch", requiredMinutes: 240 }),
    ]);
    const view = campaignViewFromCampaign(source, 0, idleSession, false);

    expect(campaignStats(view)).toMatchObject({ remaining: 450, nextRewardRemaining: 30 });

    const markup = renderDrops([expandedView(view)]);
    expect(markup).toContain("30m left");
    expect(markup).toContain("7h 30m");
    expect(markup).toContain("Campaign left");
    expect(markup).not.toContain(">left<");
  });

  it("calculates remaining time for an in-progress next watch reward", () => {
    const source = campaign("in-progress", [
      reward({ id: "reward-60", name: "60 minute reward", requirement: "watch", requiredMinutes: 60, watchedMinutes: 15, status: "in_progress" }),
    ]);
    const view = campaignViewFromCampaign(source, 0, idleSession, false);

    expect(campaignStats(view)).toMatchObject({ nextRewardRemaining: 45 });
  });

  it("does not show remaining time for a completed but unclaimed watch reward", () => {
    const source = campaign("claimable-watch", [
      reward({ id: "reward-60", name: "60 minute reward", requirement: "watch", requiredMinutes: 60, watchedMinutes: 60, status: "claimable" }),
    ]);
    const view = campaignViewFromCampaign(source, 0, idleSession, false);
    const stats = campaignStats(view);

    expect(stats.nextRewardRemaining).toBeUndefined();
    expect(renderDrops([expandedView(view)])).not.toContain("&lt;1m left");
  });

  it("models action-only campaigns without watch progress", () => {
    const source = campaign("action-only", [
      reward({ id: "purchase", name: "Purchase", requirement: "action", isWatchBased: false }),
    ]);

    const view = campaignViewFromCampaign(source, 0, idleSession, false);

    expect(view.rewards[0]).toMatchObject({ requirement: "action", progress: undefined });
    expect(campaignStats(view)).toMatchObject({ kind: "action", progress: undefined, totalRewards: 1 });
  });

  it("renders subscription-only campaigns without watch progress or exclusion controls", () => {
    const source = campaign("subscription-only", [
      reward({ id: "subscribe", name: "Subscriber Sword", requirement: "subscription", requiredSubs: 3 }),
    ]);
    const view: CampaignView = {
      ...campaignViewFromCampaign(source, 0, idleSession, false),
      excluded: true,
      farmingChannel: { name: "stale-channel" },
    };
    const markup = renderDrops([view]);

    expect(markup).toContain("Subscription required");
    expect(markup).toContain("Requires 3 qualifying subscriptions");
    expect(markup).toContain("Progress unavailable");
    expect(markup).toContain("Not earnable by watching");
    expect(markup).toContain("subscribed — refresh status");
    expect(markup).not.toContain("0/0");
    expect(markup).not.toContain("0%");
    expect(markup).not.toContain("&lt;1m");
    expect(markup).not.toContain("Exclude from farming");
    expect(markup).not.toContain("Farming");
    expect(markup).not.toContain("Excluded");
  });

  it("keeps watch controls and every reward on mixed campaigns", () => {
    const source = campaign("mixed", [
      reward({ id: "watch", name: "Watch Crown", requirement: "watch", requiredMinutes: 60, watchedMinutes: 30, status: "in_progress" }),
      reward({ id: "subscribe", name: "Subscriber Cape", requirement: "subscription", requiredSubs: 2 }),
    ]);
    const markup = renderDrops([expandedView(campaignViewFromCampaign(source, 0, idleSession, false))]);

    expect(markup).toContain("Subscription required");
    expect(markup).toContain("Watch Crown");
    expect(markup).toContain("Subscriber Cape");
    expect(markup).toContain("Exclude from farming");
    expect(markup).toContain("50%");
    expect(markup).toContain("Progress unavailable");
    expect(markup).not.toContain("&lt;1m");
  });

  it("shows campaign watch time when a non-watch reward is next", () => {
    const source = campaign("mixed", [
      reward({ id: "subscribe", name: "Subscriber Cape", requirement: "subscription", requiredSubs: 2 }),
      reward({ id: "watch", name: "Watch Crown", requirement: "watch", requiredMinutes: 60 }),
    ]);
    const markup = renderDrops([expandedView(campaignViewFromCampaign(source, 0, idleSession, false))]);

    expect(markup).toContain("1h");
    expect(markup.match(/Progress unavailable/g)).toHaveLength(1);
  });

  it("shows unknown remaining work after mixed campaign watch minutes are complete", () => {
    const source = campaign("mixed", [
      reward({
        id: "watch",
        name: "Watch Crown",
        requirement: "watch",
        requiredMinutes: 60,
        watchedMinutes: 60,
        status: "claimed",
      }),
      reward({ id: "subscribe", name: "Subscriber Cape", requirement: "subscription", requiredSubs: 2 }),
    ]);
    const markup = renderDrops([expandedView(campaignViewFromCampaign(source, 0, idleSession, false))]);

    expect(markup).not.toContain("&lt;1m");
    expect(markup.match(/Progress unavailable/g)).toHaveLength(2);
  });

  it("labels obtained subscription rewards as earned", () => {
    const source = campaign("earned-subscription", [
      reward({ id: "subscribe", name: "Earned Subscriber Badge", requirement: "subscription", requiredSubs: 1, status: "claimed" }),
    ]);
    const markup = renderDrops([expandedView(campaignViewFromCampaign(source, 0, idleSession, false))]);

    expect(markup).toContain("Earned");
    expect(markup).not.toContain("100%");
  });

  it("renders action campaigns without watch statistics", () => {
    const source = campaign("action-only", [
      reward({ id: "purchase", name: "Purchase Bonus", requirement: "action", isWatchBased: false }),
    ]);
    const markup = renderDrops([expandedView(campaignViewFromCampaign(source, 0, idleSession, false))]);

    expect(markup).toContain("Action required");
    expect(markup).toContain("Purchase Bonus");
    expect(markup).not.toContain("0%");
    expect(markup).not.toContain("&lt;1m");
    expect(markup).not.toContain("Exclude from farming");
  });

  it("disables the in-card subscription refresh while refreshing", () => {
    const source = campaign("subscription-only", [
      reward({ id: "subscribe", requirement: "subscription", requiredSubs: 1 }),
    ]);
    const markup = renderDrops([expandedView(campaignViewFromCampaign(source, 0, idleSession, false))], true);

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*subscribed — refresh status<\/button>/);
  });

  it("categorizes subscription campaigns and keeps them visible regardless of farming", () => {
    const source = campaign("subscription-only", [
      reward({ requirement: "subscription", requiredSubs: 1 }),
    ]);
    const excludedIds = new Set<string>();
    const settings = mergeSettings(undefined);

    expect(campaignFilterCategories(source, excludedIds)).toEqual(["subscription"]);
    // Decoupling: dropsListFilter is display-only, so a subscription campaign
    // stays in the Drops list even when farmingEligibility would skip it. The
    // view filter has no subscription axis to turn off.
    expect(isCampaignVisible(source, settings, excludedIds)).toBe(true);
    settings.farmingEligibility.farmSubscriptionCampaigns = false;
    expect(isCampaignVisible(source, settings, excludedIds)).toBe(true);
    expect(isCampaignVisible({
      ...source,
      rewards: [{ ...source.rewards[0], status: "claimable" }],
    }, settings, excludedIds)).toBe(true);
  });

  // Kick used to drop ended campaigns at parse time, which made these two
  // toggles dead on that platform; they must behave exactly as on Twitch.
  it("applies the finished filter to a completed Kick campaign", () => {
    const source: DropCampaign = {
      ...campaign("kick-completed", [reward({ status: "claimed" })]),
      platform: "kick",
      status: "completed",
    };
    const excludedIds = new Set<string>();
    const settings = mergeSettings(undefined);

    expect(campaignFilterCategories(source, excludedIds)).toEqual(["finished"]);
    expect(settings.dropsListFilter.showFinished).toBe(true);
    expect(isCampaignVisible(source, settings, excludedIds)).toBe(true);

    settings.dropsListFilter.showFinished = false;
    expect(isCampaignVisible(source, settings, excludedIds)).toBe(false);
  });

  it("applies the expired filter to an expired Kick campaign", () => {
    const source: DropCampaign = {
      ...campaign("kick-expired", [reward({ requiredMinutes: 30 })]),
      platform: "kick",
      status: "expired",
    };
    const excludedIds = new Set<string>();
    const settings = mergeSettings(undefined);

    expect(campaignFilterCategories(source, excludedIds)).toEqual(["expired"]);
    expect(settings.dropsListFilter.showExpired).toBe(false);
    expect(isCampaignVisible(source, settings, excludedIds)).toBe(false);

    settings.dropsListFilter.showExpired = true;
    expect(isCampaignVisible(source, settings, excludedIds)).toBe(true);
  });
});
