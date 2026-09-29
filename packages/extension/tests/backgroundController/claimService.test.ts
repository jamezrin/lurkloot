import { describe, expect, it, vi } from "vitest";
import type { DropCampaign } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { campaign, deferred, farming, harness } from "../helpers/backgroundController";
import type { SchedulerState } from "@lurkloot/shared/models";

// The claim service (#597): the drop-claim job and manual claims send their
// requests with no lock held and commit only their result, onto the latest
// state.

// Twitch paused for a manual watch in tab 91, which is when the job claims.
function watchingTwitchByHand(env: ReturnType<typeof harness>): void {
  env.state.authHealth = {
    ...env.state.authHealth,
    twitch: { status: "healthy", checkedAt: new Date().toISOString() },
  };
  env.state.sessions.twitch = { platform: "twitch", status: "paused", offlineChecks: 0, reasonCode: "manual_watch" };
  env.state.manualWatch = {
    twitch: { platform: "twitch", tabId: 91, checkedAt: new Date().toISOString(), active: true },
  };
}

// A reward as inventory reports it, with the claim id the claimed-reward
// merge matches on.
const withClaimId = (status: "claimable" | "claimed"): DropCampaign => {
  const item = campaign("twitch", status);
  return { ...item, rewards: item.rewards.map((reward) => ({ ...reward, claimId: "claim-1" })) };
};

const claimedEvents = (env: ReturnType<typeof harness>) =>
  env.reportEvents.mock.calls.flatMap(([events]) => events).filter(
    (event) => event.category === "activity" && event.code === "reward_claimed",
  );

describe("claim service", () => {
  describe("drop-claim job", () => {
    it("refreshes with no lock held and commits its claims onto the latest state", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      watchingTwitchByHand(env);
      const refresh = deferred<DropCampaign[]>();
      env.twitch.refreshCampaigns = vi.fn(async () => refresh.promise);

      const claiming = env.controller.runDropClaims("twitch");
      await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
      // The user closes the watched tab while the refresh is in flight. That
      // commit takes the Twitch lock, so it only finishes if the job holds none.
      await env.controller.handleTabRemoved(91);
      const afterClose = structuredClone(env.state.manualWatch);
      refresh.resolve([campaign("twitch", "claimable")]);
      await claiming;

      expect(env.state.manualWatch).toEqual(afterClose);
      expect(env.state.campaigns.twitch[0].rewards[0].status).toBe("claimed");
      expect(claimedEvents(env)).toHaveLength(1);
    });

    it("keeps a claim committed while its refresh was in flight", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      watchingTwitchByHand(env);
      const refresh = deferred<DropCampaign[]>();
      env.twitch.refreshCampaigns = vi.fn(async () => refresh.promise);
      env.twitch.claimReward = vi.fn(async () => false);

      const claiming = env.controller.runDropClaims("twitch");
      await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
      // Another path claimed and committed the reward meanwhile.
      await env.deps.saveState({
        ...env.state,
        campaigns: { ...env.state.campaigns, twitch: [withClaimId("claimed")] },
      });
      refresh.resolve([withClaimId("claimable")]);
      await claiming;

      expect(env.state.campaigns.twitch[0].rewards[0].status).toBe("claimed");
    });

    it("adds nothing when it fires again while it is still running", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      watchingTwitchByHand(env);
      const refresh = deferred<DropCampaign[]>();
      env.twitch.refreshCampaigns = vi.fn(async () => refresh.promise);

      const first = env.controller.runDropClaims("twitch");
      await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
      await env.controller.runDropClaims("twitch");
      refresh.resolve([campaign("twitch", "claimable")]);
      await first;

      expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
      expect(env.twitch.claimReward).toHaveBeenCalledOnce();
      expect(claimedEvents(env)).toHaveLength(1);
    });
  });

  describe("manual claim", () => {
    it("claims with no lock held and marks the reward on the latest state", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: false }));
      watchingTwitchByHand(env);
      env.state.campaigns.twitch = [campaign("twitch", "claimable")];
      const claim = deferred<boolean>();
      vi.mocked(env.twitch.claimReward).mockReturnValue(claim.promise);

      const claiming = env.rawController.handleMessage({
        type: "claimReward",
        platform: "twitch",
        campaignId: "twitch-campaign",
        rewardId: "reward",
      });
      await vi.waitFor(() => expect(env.twitch.claimReward).toHaveBeenCalledOnce());
      await env.controller.handleTabRemoved(91);
      const afterClose = structuredClone(env.state.manualWatch);
      claim.resolve(true);
      await claiming;

      expect(env.state.manualWatch).toEqual(afterClose);
      expect(env.state.campaigns.twitch[0].rewards[0].status).toBe("claimed");
      expect(claimedEvents(env)).toHaveLength(1);
    });
  });

  it("does not claim again a reward the tick is committing", async () => {
    const commitSave = deferred<void>();
    let tickSaving = false;
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: true }));
    const save = env.deps.saveState.getMockImplementation()!;
    env.deps.saveState.mockImplementation(async (next: SchedulerState) => {
      // Holds the tick's commit, the save that records the claim.
      if (!tickSaving && next.campaigns.twitch[0]?.rewards[0]?.status === "claimed") {
        tickSaving = true;
        await commitSave.promise;
      }
      await save(next);
    });
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", "claimable")]);

    const ticking = env.controller.tick(["twitch"]);
    await vi.waitFor(() => expect(tickSaving).toBe(true));
    const manual = env.rawController.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: "reward",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    commitSave.resolve();
    await Promise.all([ticking, manual]);

    expect(env.twitch.claimReward).toHaveBeenCalledOnce();
    expect(claimedEvents(env)).toHaveLength(1);
  });
});
