import { describe, expect, it } from "vitest";
import type { DropCampaign, DropReward } from "@lurkloot/shared/models";
import {
  applySubscriptionMarks,
  canMarkSubscription,
  isRewardAvailableToEarn,
  isRewardObtained,
  isWaitingSubscriptionReward,
  isWatchReward,
  reconcileCampaignAfterClaims,
  rewardRequirementType,
  subscriptionMarkKey,
} from "@lurkloot/shared/rewards";
import { evaluateCampaignFarming } from "@lurkloot/shared/campaignFarming";
import { campaignSection, isCampaignFinished } from "@lurkloot/shared/campaignFilters";
import { mergeEngineSettings } from "@lurkloot/shared/settings";

// Rewards as the Twitch parser reports them: a subscription reward, a watch
// reward that needs it first, and a reward that needs a subscription plus
// watch time. Their prerequisites are already reconciled, as parsed.
function subscriptionReward(overrides: Partial<DropReward> = {}): DropReward {
  return { id: "sub", name: "Sub reward", requiredMinutes: 0, requiredSubs: 1, requirement: "subscription", isWatchBased: false, watchedMinutes: 0, status: "locked", preconditionsMet: true, ...overrides };
}

function gatedWatchReward(overrides: Partial<DropReward> = {}): DropReward {
  return { id: "watch", name: "Watch reward", requiredMinutes: 60, requirement: "watch", isWatchBased: true, watchedMinutes: 0, status: "locked", preconditionRewardIds: ["sub"], preconditionsMet: false, ...overrides };
}

function subscriptionPlusWatchReward(overrides: Partial<DropReward> = {}): DropReward {
  return { id: "combined", name: "Watch and Subscribe", requiredMinutes: 60, requiredSubs: 1, requirement: "subscription", isWatchBased: false, watchedMinutes: 0, status: "locked", preconditionsMet: true, ...overrides };
}

function twitchCampaign(rewards: DropReward[]): DropCampaign {
  return { id: "campaign", platform: "twitch", name: "Campaign", status: "active", eligibility: "waiting_for_subscription", endsAt: "2999-01-01T00:00:00.000Z", rewards };
}

const mark = (rewardId: string) => subscriptionMarkKey("campaign", rewardId);

describe("subscription marks", () => {
  it("keys a mark by campaign and reward", () => {
    expect(subscriptionMarkKey("campaign", "sub")).toBe("campaign:sub");
  });

  it("only offers a mark on a subscription reward the platform has not released", () => {
    expect(canMarkSubscription(subscriptionReward())).toBe(true);
    expect(canMarkSubscription(subscriptionReward({ status: "in_progress" }))).toBe(true);
    expect(canMarkSubscription(subscriptionReward({ status: "claimable" }))).toBe(false);
    expect(canMarkSubscription(subscriptionReward({ status: "claimed" }))).toBe(false);
    expect(canMarkSubscription(gatedWatchReward())).toBe(false);
  });

  it("treats a marked subscription reward as obtained and unlocks the rewards that need it", () => {
    const campaign = applySubscriptionMarks(twitchCampaign([subscriptionReward(), gatedWatchReward()]), [mark("sub")]);
    const [sub, watch] = campaign.rewards;

    expect(sub).toMatchObject({ subscriptionMarked: true, status: "locked" });
    expect(isRewardObtained(sub)).toBe(true);
    expect(isWaitingSubscriptionReward(sub)).toBe(false);
    expect(watch.preconditionsMet).toBe(true);
    expect(campaign.status).toBe("active");
    expect(campaign.eligibility).toBe("waiting_for_subscription");
  });

  it("makes a marked subscription plus watch reward a watch reward until its minutes are done", () => {
    const [reward] = applySubscriptionMarks(
      twitchCampaign([subscriptionPlusWatchReward({ watchedMinutes: 20, status: "in_progress" })]),
      [mark("combined")],
    ).rewards;

    expect(rewardRequirementType(reward)).toBe("watch");
    expect(isWatchReward(reward)).toBe(true);
    expect(isRewardObtained(reward)).toBe(false);
    expect(isRewardAvailableToEarn(reward)).toBe(true);
    // Done watching but not released by Twitch: only Twitch can move it on.
    expect(isRewardAvailableToEarn({ ...reward, watchedMinutes: 60 })).toBe(false);
  });

  it("ignores a mark once the platform releases or confirms the reward", () => {
    for (const status of ["claimable", "claimed"] as const) {
      const [reward] = applySubscriptionMarks(twitchCampaign([subscriptionReward({ status })]), [mark("sub")]).rewards;
      expect(reward.subscriptionMarked).toBeUndefined();
    }
  });

  it("restores the platform's view when the mark is removed", () => {
    const source = twitchCampaign([subscriptionReward(), gatedWatchReward()]);
    const marked = applySubscriptionMarks(source, [mark("sub")]);

    expect(applySubscriptionMarks(marked, [])).toEqual(source);
  });

  it("leaves a campaign with no marks of its own untouched", () => {
    const source = twitchCampaign([subscriptionReward(), gatedWatchReward()]);

    expect(applySubscriptionMarks(source, [])).toBe(source);
    expect(applySubscriptionMarks(source, ["another-campaign:sub", "campaign-typo"])).toBe(source);
    expect(applySubscriptionMarks(source, ["campaign:no-such-reward"])).toEqual(source);
  });

  it("lets claim reconciliation honour a mark for prerequisites but not for completion", () => {
    const campaign = applySubscriptionMarks(twitchCampaign([subscriptionReward(), gatedWatchReward()]), [mark("sub")]);
    const reconciled = reconcileCampaignAfterClaims(campaign, campaign.rewards);

    expect(reconciled.rewards[1].preconditionsMet).toBe(true);
    expect(reconciled.status).toBe("active");
    expect(reconciled.eligibility).toBe("waiting_for_subscription");
  });
});

describe("subscription marks in farmability", () => {
  const settings = mergeEngineSettings(undefined);

  it("farms a watch reward whose subscription prerequisite is marked", () => {
    const source = twitchCampaign([subscriptionReward(), gatedWatchReward()]);

    expect(evaluateCampaignFarming(source, settings).farmable).toBe(false);
    expect(evaluateCampaignFarming(applySubscriptionMarks(source, [mark("sub")]), settings)).toMatchObject({ farmable: true });
  });

  it("farms a marked subscription plus watch reward", () => {
    const source = twitchCampaign([subscriptionPlusWatchReward()]);

    expect(evaluateCampaignFarming(source, settings).farmable).toBe(false);
    expect(evaluateCampaignFarming(applySubscriptionMarks(source, [mark("combined")]), settings)).toMatchObject({ farmable: true });
  });

  it("finishes a fully marked subscription-only campaign without changing its status", () => {
    const campaign = applySubscriptionMarks(twitchCampaign([subscriptionReward()]), [mark("sub")]);

    expect(evaluateCampaignFarming(campaign, settings)).toMatchObject({ farmable: false, code: "no_unclaimed_rewards" });
    expect(isCampaignFinished(campaign)).toBe(true);
    expect(campaignSection(campaign, settings)).toBe("completed");
    expect(campaign.status).toBe("active");
    expect(campaign.eligibility).toBe("waiting_for_subscription");
  });

  it("keeps a campaign open while one of its subscription tiers is unmarked", () => {
    const campaign = applySubscriptionMarks(
      twitchCampaign([subscriptionReward(), subscriptionReward({ id: "five-gifts", requiredSubs: 5 })]),
      [mark("sub")],
    );

    expect(isCampaignFinished(campaign)).toBe(false);
    expect(campaignSection(campaign, settings)).toBe("skipped");
  });
});
