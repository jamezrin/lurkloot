import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DropCampaign, DropReward, WatchSession } from "@lurkloot/shared/models";
import { mergeSettings } from "@lurkloot/shared/settings";
import { CAMPAIGN_FILTERS } from "../../popup-ui/src/constants";
import { DropsPanel } from "../../popup-ui/src/drops";
import {
  campaignFilterCategories,
  campaignStats,
  campaignViewFromCampaign,
  isCampaignVisible,
} from "../../popup-ui/src/viewModels";

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

  it("renders unknown progress without showing a fabricated zero percent", () => {
    const source = campaign("subscription-only", [
      reward({ id: "subscribe", name: "Subscribe", requirement: "subscription", requiredSubs: 1 }),
    ]);
    const view = campaignViewFromCampaign(source, 0, idleSession, false);
    let markup = "";

    expect(() => {
      markup = renderToStaticMarkup(createElement(DropsPanel, {
        campaigns: [view],
        gameMap: {},
        onReorder: () => {},
        onToggleExclude: () => {},
      }));
    }).not.toThrow();
    expect(markup).toContain(">—</span>");
    expect(markup).not.toContain(">0%</span>");
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
