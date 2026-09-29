import { describe, expect, it, vi } from "vitest";
import type { DropCampaign } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { campaign, channel, deferred, farming, harness, reward } from "../helpers/backgroundController";
import type { PreparedWatchTab, SchedulerState } from "@lurkloot/shared/models";

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

  describe("reservation until commit", () => {
    // A tick that claims the first reward, then stalls opening the watch tab
    // for the next one, before it commits anything.
    function tickStalledAfterClaim() {
      const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: true }));
      vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([{
        ...campaign("twitch", "claimable"),
        rewards: [reward("claimable"), { ...reward("in_progress"), id: "next" }],
      }]);
      vi.mocked(env.twitch.listCandidateChannels).mockResolvedValue([channel("twitch")]);
      const opening = deferred<void>();
      const open = env.watchTabs.twitch.open.getMockImplementation()!;
      env.watchTabs.twitch.open.mockImplementationOnce(async (...args) => {
        await opening.promise;
        return await open(...args);
      });
      return { env, opening };
    }

    it("sends no second claim for a reward the tick claimed but has not committed", async () => {
      const { env, opening } = tickStalledAfterClaim();

      const ticking = env.controller.tick(["twitch"]);
      await vi.waitFor(() => expect(env.watchTabs.twitch.open).toHaveBeenCalledOnce());
      expect(env.twitch.claimReward).toHaveBeenCalledOnce();
      await env.rawController.handleMessage({
        type: "claimReward",
        platform: "twitch",
        campaignId: "twitch-campaign",
        rewardId: "reward",
      });
      opening.resolve();
      await ticking;
      await env.controller.settleBackgroundWork();

      expect(env.twitch.claimReward).toHaveBeenCalledOnce();
      expect(claimedEvents(env)).toHaveLength(1);
      expect(env.state.campaigns.twitch[0].rewards[0].status).toBe("claimed");
    });

    it("releases the reward when the tick holding it is aborted", async () => {
      const { env, opening } = tickStalledAfterClaim();

      const ticking = env.controller.tick(["twitch"]);
      await vi.waitFor(() => expect(env.watchTabs.twitch.open).toHaveBeenCalledOnce());
      await env.controller.prepareForHostReset();
      opening.resolve();
      await Promise.allSettled([ticking]);
      // The aborted tick recorded nothing, so the reward is claimable again.
      env.state.campaigns.twitch = [campaign("twitch", "claimable")];
      await env.rawController.handleMessage({
        type: "claimReward",
        platform: "twitch",
        campaignId: "twitch-campaign",
        rewardId: "reward",
      });

      expect(env.twitch.claimReward).toHaveBeenCalledTimes(2);
    });
  });

  describe("authentication loss", () => {
    it("ends a drop-claim run before it claims", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: true }));
      watchingTwitchByHand(env);
      const refresh = deferred<DropCampaign[]>();
      env.twitch.refreshCampaigns = vi.fn(async () => refresh.promise);

      const claiming = env.controller.runDropClaims("twitch");
      await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
      await env.controller.invalidateAuthHealth("twitch");
      refresh.resolve([campaign("twitch", "claimable")]);
      await claiming;

      expect(env.twitch.claimReward).not.toHaveBeenCalled();
      expect(claimedEvents(env)).toHaveLength(0);
    });

    it("ends a running post-claim handoff", async () => {
      const parked: AbortSignal[] = [];
      const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: true, postClaimHandoff: true }), {
        wait: (_ms, signal) => new Promise<void>((resolve) => {
          parked.push(signal);
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      });
      env.twitch.supportsPostClaimHandoff = true;
      env.state.authHealth = { ...env.state.authHealth, twitch: { status: "healthy", checkedAt: new Date().toISOString() } };

      const handoff = env.controller.runClaimHandoff("twitch", ["reward"]);
      await vi.waitFor(() => expect(parked).toHaveLength(1));
      await env.controller.invalidateAuthHealth("twitch");
      await handoff;

      expect(parked[0].aborted).toBe(true);
    });

    it("records a claim the provider accepted before authentication was lost", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: true }));
      watchingTwitchByHand(env);
      env.twitch.refreshCampaigns = vi.fn(async () => [campaign("twitch", "claimable")]);
      const accepted = deferred<boolean>();
      vi.mocked(env.twitch.claimReward).mockReturnValue(accepted.promise);

      const claiming = env.controller.runDropClaims("twitch");
      await vi.waitFor(() => expect(env.twitch.claimReward).toHaveBeenCalledOnce());
      await env.controller.invalidateAuthHealth("twitch");
      accepted.resolve(true);
      await claiming;

      expect(env.state.campaigns.twitch[0].rewards[0].status).toBe("claimed");
      expect(claimedEvents(env)).toHaveLength(1);
    });

    it("leaves the other platform's drop-claim run alone", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: true }));
      env.state.authHealth = {
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
        kick: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.kick = { platform: "kick", status: "paused", offlineChecks: 0, reasonCode: "manual_watch" };
      env.state.manualWatch = {
        kick: { platform: "kick", tabId: 92, checkedAt: new Date().toISOString(), active: true },
      };
      const refresh = deferred<DropCampaign[]>();
      env.kick.refreshCampaigns = vi.fn(async () => refresh.promise);

      const claiming = env.controller.runDropClaims("kick");
      await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
      await env.controller.invalidateAuthHealth("twitch");
      refresh.resolve([campaign("kick", "claimable")]);
      await claiming;

      expect(env.kick.claimReward).toHaveBeenCalledOnce();
      expect(env.state.campaigns.kick[0].rewards[0].status).toBe("claimed");
    });
  });
});
