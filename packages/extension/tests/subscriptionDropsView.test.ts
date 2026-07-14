import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DropCampaign, DropReward, WatchSession } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";
import { CAMPAIGN_FILTERS } from "../../popup-ui/src/constants";
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
  earned: "Earned",
  excludeFromFarming: "Exclude from farming",
  notEarnableByWatching: "Not earnable by watching",
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
    const view = campaignViewFromCampaign(source, 0, idleSession, false);
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
  });

  it("keeps watch controls and every reward on mixed campaigns", () => {
    const source = campaign("mixed", [
      reward({ id: "watch", name: "Watch Crown", requirement: "watch", requiredMinutes: 60, watchedMinutes: 30, status: "in_progress" }),
      reward({ id: "subscribe", name: "Subscriber Cape", requirement: "subscription", requiredSubs: 2 }),
    ]);
    const markup = renderDrops([campaignViewFromCampaign(source, 0, idleSession, false)]);

    expect(markup).toContain("Subscription required");
    expect(markup).toContain("Watch Crown");
    expect(markup).toContain("Subscriber Cape");
    expect(markup).toContain("Exclude from farming");
    expect(markup).toContain("50%");
    expect(markup).toContain("Progress unavailable");
    expect(markup).not.toContain("&lt;1m");
  });

  it("labels obtained subscription rewards as earned", () => {
    const source = campaign("earned-subscription", [
      reward({ id: "subscribe", name: "Earned Subscriber Badge", requirement: "subscription", requiredSubs: 1, status: "claimed" }),
    ]);
    const markup = renderDrops([campaignViewFromCampaign(source, 0, idleSession, false)]);

    expect(markup).toContain("Earned");
    expect(markup).not.toContain("100%");
  });

  it("renders action campaigns without watch statistics", () => {
    const source = campaign("action-only", [
      reward({ id: "purchase", name: "Purchase Bonus", requirement: "action", isWatchBased: false }),
    ]);
    const markup = renderDrops([campaignViewFromCampaign(source, 0, idleSession, false)]);

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
    const markup = renderDrops([campaignViewFromCampaign(source, 0, idleSession, false)], true);

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*subscribed — refresh status<\/button>/);
  });

  it("categorizes and filters subscription campaigns while preserving claimable visibility", () => {
    const source = campaign("subscription-only", [
      reward({ requirement: "subscription", requiredSubs: 1 }),
    ]);
    const excludedIds = new Set<string>();
    const settings = mergeSettings(undefined);

    expect(campaignFilterCategories(source, excludedIds)).toEqual(["subscription"]);
    expect(isCampaignVisible(source, settings, excludedIds)).toBe(true);

    settings.campaignVisibility.subscription = false;
    expect(isCampaignVisible(source, settings, excludedIds)).toBe(false);
    expect(isCampaignVisible({
      ...source,
      rewards: [{ ...source.rewards[0], status: "claimable" }],
    }, settings, excludedIds)).toBe(true);
  });

  it("exposes the subscription campaign filter", () => {
    expect(CAMPAIGN_FILTERS).toContainEqual({ key: "subscription", label: "subscriptionCampaigns" });
  });
});
