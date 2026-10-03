import { describe, expect, it, vi } from "vitest";
import type { DropCampaign, DropReward, ExtensionSettings } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { subscriptionMarkKey } from "@lurkloot/shared/rewards";
import { farming, harness } from "../helpers/backgroundController";

// Subscription marks enter the engine wherever adapter output does: the
// discovery snapshot, the tick commit and the claim service's refresh
// (docs/superpowers/specs/2026-10-03-subscription-marks-design.md).

const CAMPAIGN = "twitch-campaign";

function subscriptionReward(overrides: Partial<DropReward> = {}): DropReward {
  return { id: "sub", name: "Sub reward", requiredMinutes: 0, requiredSubs: 1, requirement: "subscription", isWatchBased: false, watchedMinutes: 0, status: "locked", preconditionsMet: true, ...overrides };
}

function gatedWatchReward(overrides: Partial<DropReward> = {}): DropReward {
  return { id: "watch", name: "Watch reward", requiredMinutes: 60, requirement: "watch", isWatchBased: true, watchedMinutes: 0, status: "locked", preconditionRewardIds: ["sub"], preconditionsMet: false, ...overrides };
}

function twitchCampaign(rewards: DropReward[]): DropCampaign {
  return { id: CAMPAIGN, platform: "twitch", name: "Twitch campaign", status: "active", eligibility: "waiting_for_subscription", endsAt: "2999-01-01T00:00:00.000Z", rewards };
}

function withMarks(settings: ExtensionSettings, ...rewardIds: string[]): ExtensionSettings {
  return {
    ...settings,
    platform: {
      ...settings.platform,
      twitch: { ...settings.platform.twitch, subscribedRewardMarks: rewardIds.map((id) => subscriptionMarkKey(CAMPAIGN, id)) },
    },
  };
}

describe("subscription marks in the engine", () => {
  it("farms a watch reward once its subscription prerequisite is marked", async () => {
    const unmarked = harness(farming(DEFAULT_SETTINGS));
    vi.mocked(unmarked.twitch.refreshCampaigns).mockResolvedValue([twitchCampaign([subscriptionReward(), gatedWatchReward()])]);
    await unmarked.controller.tick();
    expect(unmarked.state.sessions.twitch.rewardId).not.toBe("watch");

    const env = harness(withMarks(farming(DEFAULT_SETTINGS), "sub"));
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([twitchCampaign([subscriptionReward(), gatedWatchReward()])]);
    await env.controller.tick();

    expect(env.state.sessions.twitch).toMatchObject({ campaignId: CAMPAIGN, rewardId: "watch" });
    expect(env.state.campaigns.twitch[0].rewards[0]).toMatchObject({ status: "locked", subscriptionMarked: true });
  });

  it("never notifies, and undo restores the platform's view", async () => {
    const env = harness(withMarks(farming({ ...DEFAULT_SETTINGS, notifyRewardEarned: true }), "sub"));
    const source = () => [twitchCampaign([subscriptionReward(), gatedWatchReward()])];
    env.state.campaigns.twitch = source();
    vi.mocked(env.twitch.refreshCampaigns).mockImplementation(async () => source());

    await env.controller.tick();
    expect(env.state.sessions.twitch.rewardId).toBe("watch");

    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { twitch: { subscribedRewardMarks: [] } } } });
    await env.controller.tick();

    const [sub, watch] = env.state.campaigns.twitch[0].rewards;
    expect(sub.subscriptionMarked).toBeUndefined();
    expect(sub.status).toBe("locked");
    expect(watch.preconditionsMet).toBe(false);
    expect(env.state.sessions.twitch.rewardId).not.toBe("watch");
    expect(env.deps.createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Reward earned" }));
  });

  it("claims a marked reward once Twitch releases it", async () => {
    const env = harness(withMarks(farming(DEFAULT_SETTINGS), "sub"));
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([
      twitchCampaign([subscriptionReward({ status: "claimable", claimId: "viewer#twitch-campaign#sub" })]),
    ]);

    await env.controller.tick();

    expect(env.twitch.claimReward).toHaveBeenCalledWith(
      expect.objectContaining({ id: CAMPAIGN }),
      expect.objectContaining({ id: "sub", status: "claimable" }),
      expect.anything(),
    );
  });

  it("does not report a fully marked campaign as waiting for a subscription", async () => {
    const env = harness(withMarks(farming(DEFAULT_SETTINGS), "sub"));
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([twitchCampaign([subscriptionReward()])]);

    await env.controller.tick();

    expect(env.state.sessions.twitch.message ?? "").not.toContain("Waiting for a qualifying subscription");
  });

  it("keeps marks through the claim service's refresh", async () => {
    const env = harness(withMarks(farming(DEFAULT_SETTINGS), "sub"));
    env.state.authHealth = { ...env.state.authHealth, twitch: { status: "healthy", checkedAt: new Date().toISOString() } };
    env.state.sessions.twitch = { platform: "twitch", status: "paused", offlineChecks: 0, reasonCode: "manual_watch" };
    env.state.manualWatch = { twitch: { platform: "twitch", tabId: 91, checkedAt: new Date().toISOString(), active: true } };
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([twitchCampaign([subscriptionReward(), gatedWatchReward()])]);

    await env.controller.runDropClaims("twitch");

    const [sub, watch] = env.state.campaigns.twitch[0].rewards;
    expect(sub.subscriptionMarked).toBe(true);
    expect(watch.preconditionsMet).toBe(true);
  });
});
