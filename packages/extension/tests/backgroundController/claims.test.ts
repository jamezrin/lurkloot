import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXTENSION_CAPABILITIES,
  runBackgroundJob,
  KICK_CHALLENGES_ALARM_NAME,
  KICK_DROP_CLAIMS_ALARM_NAME,
  TWITCH_DROP_CLAIMS_ALARM_NAME,
} from "@lurkloot/core/controller";
import type { DropCampaign, DropReward, ExtensionSettings } from "@lurkloot/shared/models";
import type { EngineEvent } from "@lurkloot/shared/events";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import type { TablessWatchController } from "@lurkloot/core/tablessWatch";
import {
  aggregateHeartbeatDiagnostics,
  allDiagnostics,
  asSnapshot,
  campaign,
  deferred,
  drainMicrotasks,
  fakeTablessWatcher,
  farming,
  harness,
  manualWait,
  reward,
} from "../helpers/backgroundController";

// Drop claims, manual claims, claim handoffs and the manual-watch claim jobs.

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("manual-watch claim alarm lifecycle", () => {
    it("creates drop alarms at the scheduler interval and a ten-minute Kick challenge alarm", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, pollIntervalMinutes: 60 }));

      await env.controller.ensureAlarm();

      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        TWITCH_DROP_CLAIMS_ALARM_NAME,
        { periodInMinutes: 60 },
      );
      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        KICK_DROP_CLAIMS_ALARM_NAME,
        { periodInMinutes: 60 },
      );
      expect(env.deps.createAlarm).toHaveBeenCalledWith(
        KICK_CHALLENGES_ALARM_NAME,
        { periodInMinutes: 10 },
      );
    });

    it("routes each claim alarm to its claim-only operation", () => {
      const controller = {
        tickAndHandOff: vi.fn(async () => undefined),
        runWatchHeartbeat: vi.fn(async () => undefined),
        runTwitchChannelPointsClaim: vi.fn(async () => undefined),
        runTwitchIntegrityRefresh: vi.fn(async () => undefined),
        runDropClaims: vi.fn(async () => undefined),
        runKickChallengeClaims: vi.fn(async () => undefined),
      };
      for (const name of [TWITCH_DROP_CLAIMS_ALARM_NAME, KICK_DROP_CLAIMS_ALARM_NAME, KICK_CHALLENGES_ALARM_NAME]) {
        void runBackgroundJob(name, controller, EXTENSION_CAPABILITIES);
      }

      expect(controller.runDropClaims.mock.calls).toEqual([["twitch"], ["kick"]]);
      expect(controller.runKickChallengeClaims).toHaveBeenCalledOnce();
    });

    it("reconciles claim alarms after settings changes", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));

      await env.controller.handleMessage({
        type: "saveSettings",
        settingsPatch: {
          autoClaim: false,
          platform: { kick: { autoClaimChallenges: false } },
        },
      });

      expect(env.deps.clearAlarm).toHaveBeenCalledWith(TWITCH_DROP_CLAIMS_ALARM_NAME);
      expect(env.deps.clearAlarm).toHaveBeenCalledWith(KICK_DROP_CLAIMS_ALARM_NAME);
      expect(env.deps.clearAlarm).toHaveBeenCalledWith(KICK_CHALLENGES_ALARM_NAME);
    });

    it("clears claim alarms during reset and shutdown", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));

      await env.controller.prepareForHostReset();
      env.controller.shutdown();
      await env.controller.settleBackgroundWork();

      for (const alarm of [TWITCH_DROP_CLAIMS_ALARM_NAME, KICK_DROP_CLAIMS_ALARM_NAME, KICK_CHALLENGES_ALARM_NAME]) {
        expect(env.deps.clearAlarm).toHaveBeenCalledWith(alarm);
      }
    });
  });

  describe("manual-watch claim-only operations", () => {
    it.each(["twitch", "kick"] as const)("claims %s drops without changing the paused session", async (platform) => {
      const env = harness(farming(DEFAULT_SETTINGS));
      env.state.authHealth = {
        ...env.state.authHealth,
        [platform]: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions[platform] = {
        platform,
        status: "paused",
        offlineChecks: 0,
        reasonCode: "manual_watch",
        message: "Manual watch detected",
      };
      env.state.manualWatch = {
        [platform]: {
          platform,
          tabId: 91,
          checkedAt: new Date().toISOString(),
          active: true,
        },
      };
      const beforeSession = structuredClone(env.state.sessions[platform]);
      const platformAdapter = platform === "twitch" ? env.twitch : env.kick;
      platformAdapter.refreshCampaigns = vi.fn(async () => [campaign(platform, "claimable")]);
      platformAdapter.claimReward = vi.fn(async () => true);

      await env.controller.runDropClaims(platform);

      expect(platformAdapter.refreshCampaigns).toHaveBeenCalledWith(
        beforeSession,
        expect.objectContaining({ requireComplete: true }),
      );
      expect(env.state.sessions[platform]).toEqual(beforeSession);
      expect(env.state.manualWatch?.[platform]?.active).toBe(true);
      expect(env.state.campaigns[platform][0]?.rewards[0]?.status).toBe("claimed");
      expect(allDiagnostics(env).some((event) => event.message.includes("Manual watch detected"))).toBe(false);
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
        category: "activity",
        code: "reward_claimed",
        platform,
        data: expect.objectContaining({ method: "automatic", rewardId: "reward" }),
      }));
      expect(platformAdapter.prepareWatchTab).not.toHaveBeenCalled();
      expect(platformAdapter.stopWatchTab).not.toHaveBeenCalled();
    });

    it("claims Kick challenges without changing the paused session", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      env.state.authHealth = {
        ...env.state.authHealth,
        kick: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.kick = {
        platform: "kick",
        status: "paused",
        offlineChecks: 0,
        reasonCode: "manual_watch",
        message: "Manual watch detected",
      };
      env.state.manualWatch = {
        kick: {
          platform: "kick",
          tabId: 92,
          checkedAt: new Date().toISOString(),
          active: true,
        },
      };
      const beforeSession = structuredClone(env.state.sessions.kick);
      env.kick.claimChallenges = vi.fn(async () => [{ id: "daily", rarity: "epic", recurrence: "daily" }]);

      await env.controller.runKickChallengeClaims();

      expect(env.state.sessions.kick).toEqual(beforeSession);
      expect(env.state.manualWatch?.kick?.active).toBe(true);
      expect(env.state.gamification?.kick?.lastCheckedAt).toBeDefined();
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
        category: "activity",
        code: "challenge_claimed",
        platform: "kick",
        data: { challengeId: "daily", rarity: "epic", recurrence: "daily" },
      }));
      expect(env.kick.prepareWatchTab).not.toHaveBeenCalled();
      expect(env.kick.stopWatchTab).not.toHaveBeenCalled();
    });

    it("does not duplicate drop or challenge claims without a recent manual watch", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      env.state.authHealth = {
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
        kick: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.kick.claimChallenges = vi.fn(async () => []);

      await env.controller.runDropClaims("twitch");
      await env.controller.runDropClaims("kick");
      await env.controller.runKickChallengeClaims();

      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.kick.claimChallenges).not.toHaveBeenCalled();
    });

    it("reports a drop refresh failure without changing paused state", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "paused",
        offlineChecks: 0,
        reasonCode: "manual_watch",
      };
      env.state.manualWatch = {
        twitch: { platform: "twitch", tabId: 91, checkedAt: new Date().toISOString(), active: true },
      };
      const before = structuredClone(env.state);
      env.twitch.refreshCampaigns = vi.fn(async () => { throw new Error("inventory unavailable"); });

      await env.controller.runDropClaims("twitch");

      expect(env.state).toEqual(before);
      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        platform: "twitch",
        level: "warn",
        message: "inventory unavailable",
      }));
    });

    it("throttles repeated Kick challenge alarms", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      env.state.authHealth = {
        ...env.state.authHealth,
        kick: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.kick = { platform: "kick", status: "paused", offlineChecks: 0, reasonCode: "manual_watch" };
      env.state.manualWatch = {
        kick: { platform: "kick", tabId: 92, checkedAt: new Date().toISOString(), active: true },
      };
      env.state.gamification = { kick: { lastCheckedAt: new Date().toISOString() } };
      env.kick.claimChallenges = vi.fn(async () => []);

      await env.controller.runKickChallengeClaims();

      expect(env.kick.claimChallenges).not.toHaveBeenCalled();
    });

    it("contains drop-claim persistence failures without publishing a claim event", async () => {
      const env = harness(farming(DEFAULT_SETTINGS), {
        saveState: async () => { throw new Error("state storage unavailable"); },
      });
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = { platform: "twitch", status: "paused", offlineChecks: 0, reasonCode: "manual_watch" };
      env.state.manualWatch = {
        twitch: { platform: "twitch", tabId: 91, checkedAt: new Date().toISOString(), active: true },
      };
      env.twitch.refreshCampaigns = vi.fn(async () => [campaign("twitch", "claimable")]);

      await expect(env.controller.runDropClaims("twitch")).resolves.toBeUndefined();

      const reported = env.reportEvents.mock.calls.flatMap(([events]) => events);
      expect(reported.some((event) => event.category === "activity" && event.code === "reward_claimed")).toBe(false);
      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({ message: "state storage unavailable" }));
    });

    it("contains Kick challenge persistence failures without publishing a claim event", async () => {
      const env = harness(farming(DEFAULT_SETTINGS), {
        saveState: async () => { throw new Error("state storage unavailable"); },
      });
      env.state.authHealth = {
        ...env.state.authHealth,
        kick: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.kick = { platform: "kick", status: "paused", offlineChecks: 0, reasonCode: "manual_watch" };
      env.state.manualWatch = {
        kick: { platform: "kick", tabId: 92, checkedAt: new Date().toISOString(), active: true },
      };
      env.kick.claimChallenges = vi.fn(async () => [{ id: "daily", rarity: "epic", recurrence: "daily" }]);

      await expect(env.controller.runKickChallengeClaims()).resolves.toBeUndefined();

      const reported = env.reportEvents.mock.calls.flatMap(([events]) => events);
      expect(reported.some((event) => event.category === "activity" && event.code === "challenge_claimed")).toBe(false);
      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({ message: "state storage unavailable" }));
    });

    it.each([
      { name: "drop", run: (env: ReturnType<typeof harness>) => env.controller.runDropClaims("twitch") },
      { name: "challenge", run: (env: ReturnType<typeof harness>) => env.controller.runKickChallengeClaims() },
    ])("contains $name adapter construction failures", async ({ run }) => {
      const env = harness(farming(DEFAULT_SETTINGS));
      env.state.authHealth = {
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
        kick: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = { platform: "twitch", status: "paused", offlineChecks: 0, reasonCode: "manual_watch" };
      env.state.sessions.kick = { platform: "kick", status: "paused", offlineChecks: 0, reasonCode: "manual_watch" };
      env.state.manualWatch = {
        twitch: { platform: "twitch", tabId: 91, checkedAt: new Date().toISOString(), active: true },
        kick: { platform: "kick", tabId: 92, checkedAt: new Date().toISOString(), active: true },
      };
      env.deps.createAdapter.mockImplementationOnce(() => { throw new Error("adapter unavailable"); });

      await expect(run(env)).resolves.toBeUndefined();

      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        level: "warn",
        message: "adapter unavailable",
      }));
    });

    it("cancels an in-flight drop claim when automatic claiming is disabled", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      env.state.authHealth = {
        ...env.state.authHealth,
        twitch: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.twitch = { platform: "twitch", status: "paused", offlineChecks: 0, reasonCode: "manual_watch" };
      env.state.manualWatch = {
        twitch: { platform: "twitch", tabId: 91, checkedAt: new Date().toISOString(), active: true },
      };
      const refresh = deferred<DropCampaign[]>();
      env.twitch.refreshCampaigns = vi.fn(async () => refresh.promise);

      const claiming = env.controller.runDropClaims("twitch");
      await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
      await env.rawController.handleMessage({ type: "saveSettings", settingsPatch: { autoClaim: false } });
      refresh.resolve([campaign("twitch", "claimable")]);
      await claiming;

      expect(env.twitch.claimReward).not.toHaveBeenCalled();
      expect(env.state.campaigns.twitch).toEqual([]);
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events).some(
        (event) => event.category === "activity" && event.code === "reward_claimed",
      )).toBe(false);
    });

    it("cancels an in-flight Kick challenge claim when challenge claiming is disabled", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      env.state.authHealth = {
        ...env.state.authHealth,
        kick: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.kick = { platform: "kick", status: "paused", offlineChecks: 0, reasonCode: "manual_watch" };
      env.state.manualWatch = {
        kick: { platform: "kick", tabId: 92, checkedAt: new Date().toISOString(), active: true },
      };
      const challenges = deferred<Array<{ id: string; rarity: string; recurrence: string }>>();
      env.kick.claimChallenges = vi.fn(async () => challenges.promise);

      const claiming = env.controller.runKickChallengeClaims();
      await vi.waitFor(() => expect(env.kick.claimChallenges).toHaveBeenCalledOnce());
      await env.rawController.handleMessage({
        type: "saveSettings",
        settingsPatch: { platform: { kick: { autoClaimChallenges: false } } },
      });
      challenges.resolve([{ id: "daily", rarity: "epic", recurrence: "daily" }]);
      await claiming;

      expect(env.state.gamification?.kick).toBeUndefined();
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events).some(
        (event) => event.category === "activity" && event.code === "challenge_claimed",
      )).toBe(false);
    });
  });

  it("completes a campaign after manually claiming its last subscription reward", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: false }));
    const subscriptionReward: DropReward = {
      ...reward("claimable"),
      id: "subscription-reward",
      imageUrl: "https://cdn.example.test/reward.png",
      requirement: "subscription",
      requiredSubs: 1,
      requiredMinutes: 0,
      watchedMinutes: 0,
      isWatchBased: false,
    };
    const twitchCampaign = {
      ...campaign("twitch", "claimed"),
      url: "https://example.test/campaign",
      rewards: [reward("claimed"), subscriptionReward],
    };
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([twitchCampaign]);

    await env.controller.tick();
    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: "subscription-reward",
    }));

    expect(env.twitch.claimReward).toHaveBeenCalledWith(
      expect.objectContaining({ id: "twitch-campaign" }),
      expect.objectContaining({ id: "subscription-reward", status: "claimable", requirement: "subscription" }),
    );
    expect(snapshot.state.campaigns.twitch[0]).toMatchObject({
      status: "completed",
      rewards: [
        { id: "reward", status: "claimed" },
        { id: "subscription-reward", status: "claimed", watchedMinutes: 0 },
      ],
    });
    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        category: "activity",
        code: "reward_claimed",
        data: expect.objectContaining({
          method: "manual",
          rewardImageUrl: "https://cdn.example.test/reward.png",
          campaignUrl: "https://example.test/campaign",
        }),
      }),
    ]));
  });

  it("keeps a mixed campaign active after manually claiming its subscription reward", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: false }));
    const subscriptionReward: DropReward = {
      ...reward("claimable"),
      id: "subscription-reward",
      requirement: "subscription",
      requiredSubs: 1,
      requiredMinutes: 0,
      watchedMinutes: 0,
      isWatchBased: false,
    };
    const twitchCampaign = {
      ...campaign("twitch"),
      rewards: [subscriptionReward, { ...reward("locked"), id: "watch-reward", requirement: "watch" as const }],
    };
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([twitchCampaign]);

    await env.controller.tick();
    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: "subscription-reward",
    }));

    expect(snapshot.state.campaigns.twitch[0]).toMatchObject({
      status: "active",
      rewards: [
        { id: "subscription-reward", status: "claimed" },
        { id: "watch-reward", status: "locked" },
      ],
    });
  });

  it("unlocks a dependent watch reward immediately after a manual subscription claim", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: false }));
    const subscriptionReward: DropReward = {
      ...reward("claimable"),
      id: "subscription-reward",
      requirement: "subscription",
      requiredSubs: 1,
      requiredMinutes: 0,
      watchedMinutes: 0,
      isWatchBased: false,
    };
    const twitchCampaign: DropCampaign = {
      ...campaign("twitch"),
      eligibility: "eligible",
      rewards: [
        subscriptionReward,
        {
          ...reward("locked"),
          id: "watch-reward",
          requirement: "watch",
          preconditionRewardIds: [subscriptionReward.id],
          preconditionsMet: false,
        },
      ],
    };
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([twitchCampaign]);

    await env.controller.tick();
    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: subscriptionReward.id,
    }));

    expect(snapshot.state.campaigns.twitch[0]).toMatchObject({
      status: "active",
      eligibility: "eligible",
      rewards: [
        { id: subscriptionReward.id, status: "claimed" },
        { id: "watch-reward", status: "locked", preconditionsMet: true },
      ],
    });
  });

  it("does not publish manual-claim events when the corresponding state save fails", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: false }), {
      saveState: vi.fn().mockRejectedValueOnce(new Error("storage unavailable")),
    });
    env.state.campaigns.twitch = [campaign("twitch", "claimable")];

    await expect(env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: "reward",
    })).rejects.toThrow("storage unavailable");

    expect(env.deps.saveState).toHaveBeenCalledTimes(1);
    expect(env.reportEvents).not.toHaveBeenCalled();
  });

  it("records a warning when a manual claim target is stale", async () => {
    const env = harness();

    await env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "missing-campaign",
      rewardId: "reward",
    });

    expect(env.twitch.claimReward).not.toHaveBeenCalled();
    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "Reward claim skipped because the campaign or reward is no longer available",
      }),
    ]));
  });

  it("reports the reward ids claimed during a tick, per platform", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: true }));
    env.twitch.refreshCampaigns = vi.fn(async () => [campaign("twitch", "claimable")]);

    const claimed = await env.controller.tick();

    expect(claimed).toEqual({ twitch: ["reward"] });
  });

  it("starts post-claim handoffs independently for both platforms", async () => {
    const waitingSignals: AbortSignal[] = [];
    const env = harness(
      farming({
        ...DEFAULT_SETTINGS,
        autoClaim: true,
        postClaimHandoff: true,
      }),
      {
        wait: async (_ms, signal) => new Promise<void>((resolve) => {
          waitingSignals.push(signal);
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      },
    );
    env.twitch.supportsPostClaimHandoff = true;
    env.kick.supportsPostClaimHandoff = true;
    env.twitch.refreshCampaigns = vi.fn(async () => [campaign("twitch", "claimable")]);
    env.kick.refreshCampaigns = vi.fn(async () => [campaign("kick", "claimable")]);

    const running = env.controller.tickAndHandOff();
    try {
      await vi.waitFor(() => expect(waitingSignals).toHaveLength(2));
    } finally {
      env.controller.shutdown();
      await running;
    }
  });

  it("reports a platform-scoped diagnostic when a post-claim handoff fails", async () => {
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      autoClaim: true,
      postClaimHandoff: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    }));
    env.twitch.supportsPostClaimHandoff = true;
    env.twitch.refreshCampaigns = vi.fn(async () => [campaign("twitch", "claimable")]);
    env.deps.createAdapters.mockImplementation(() => {
      throw new Error("handoff adapter failed");
    });

    await env.controller.tickAndHandOff(["twitch"]);

    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
      expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "Post-claim handoff failed: handoff adapter failed",
      }),
    );
  });

  describe("post-claim handoff", () => {
    // Date only: the handoff's deadline is wall-clock based, but its delays are
    // injected, so setTimeout must stay real for drainMicrotasks.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // Twitch-only environment whose adapter opts into the handoff.
    function handoffEnv(overrides: Partial<ExtensionSettings> = {}) {
      const timer = manualWait();
      const env = harness({
        ...DEFAULT_SETTINGS,
        autoClaim: true,
        platform: {
          ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
          kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
        },
        ...overrides,
      }, { wait: timer.wait });
      env.twitch.supportsPostClaimHandoff = true;
      // Re-declare the getters: spreading `env` would evaluate them once and
      // freeze the initial snapshot, so every assertion would read stale state.
      return {
        ...env,
        timer,
        get state() { return env.state; },
        get settings() { return env.settings; },
      };
    }

    // A campaign whose first reward is claimable and whose second reward only
    // becomes visible on a later inventory read — the Twitch behavior the
    // handoff exists to absorb.
    function chainedCampaign(revealSecond: boolean): DropCampaign {
      const first: DropReward = { id: "reward-1", name: "First", requiredMinutes: 60, watchedMinutes: 60, status: "claimable" };
      const second: DropReward = { id: "reward-2", name: "Second", requiredMinutes: 60, watchedMinutes: 0, status: "in_progress" };
      return {
        id: "twitch-campaign",
        platform: "twitch",
        name: "twitch campaign",
        status: "active",
        rewards: revealSecond ? [first, second] : [first],
      };
    }

    it("starts earning the next reward before the next heartbeat alarm", async () => {
      const env = handoffEnv();
      let reveal = false;
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      reveal = true;
      await env.timer.flush();
      await handoff;

      expect(env.state.sessions.twitch.rewardId).toBe("reward-2");
    });

    it("stops at the deadline when no next reward appears", async () => {
      const env = handoffEnv({ postClaimHandoffIntervalSeconds: 5, postClaimHandoffMaxSeconds: 15 });
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      for (let index = 0; index < 10; index += 1) await env.timer.flush();
      await handoff;

      // A 15s budget at a 5s interval is three refreshes, never ten.
      expect(env.timer.wait.mock.calls.length).toBeLessThanOrEqual(3);
      expect(env.deps.createAlarm).not.toHaveBeenCalled();
    });

    it("exits early when the platform has no eligible reward left", async () => {
      const env = handoffEnv();
      env.twitch.refreshCampaigns = vi.fn(async () => []);

      const handoff = env.controller.runClaimHandoff("twitch");
      await env.timer.flush();
      await handoff;

      expect(env.timer.wait).toHaveBeenCalledTimes(1);
    });

    it("aborts in flight when farming stops", async () => {
      const env = handoffEnv();
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      // Let the loop actually park before aborting, so this exercises an
      // in-flight cancellation rather than a pre-start one.
      await drainMicrotasks();
      env.controller.abortClaimHandoffs();
      await env.timer.flush();
      await handoff;

      expect(env.timer.parked).toBe(0);
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    });

    it("does not run for a platform without the capability", async () => {
      const env = handoffEnv();
      env.twitch.supportsPostClaimHandoff = undefined;

      await env.controller.runClaimHandoff("twitch");

      expect(env.timer.wait).not.toHaveBeenCalled();
    });

    it("does not suppress compatibility diagnostics when probing the capability", async () => {
      const env = handoffEnv();
      // Bails right after the capability probe, which is the call that could
      // poison the controller's compatibility dedup cache.
      env.twitch.supportsPostClaimHandoff = undefined;

      await env.controller.runClaimHandoff("twitch", ["reward-1"]);
      await env.controller.tick();

      const published = env.reportEvents.mock.calls.flatMap(([events]: [readonly EngineEvent[]]) => events);
      expect(published).toContainEqual(expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        message: expect.stringContaining("Using compatibility profile"),
      }));
    });

    it("does not run when the setting is disabled", async () => {
      const env = handoffEnv({ postClaimHandoff: false });

      await env.controller.runClaimHandoff("twitch");

      expect(env.timer.wait).not.toHaveBeenCalled();
    });

    it("anchors one immediate heartbeat 60 seconds after the switched target attempt", async () => {
      vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
      const watcher = fakeTablessWatcher(async () => {
        vi.setSystemTime(new Date("2026-09-02T12:00:17.000Z"));
        return { ok: true, live: true };
      });
      const env = handoffEnv({ tablessMode: true });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      let reveal = false;
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);
      const persist = env.deps.saveState.getMockImplementation()!;
      env.deps.saveState.mockImplementation(async (next) => {
        await persist(next);
        if (next.sessions.twitch.rewardId === "reward-2") {
          vi.setSystemTime(new Date("2026-09-02T12:00:10.000Z"));
        }
      });

      const handoff = env.controller.runClaimHandoff("twitch");
      reveal = true;
      await env.timer.flush();
      await handoff;

      expect(watcher.tick).toHaveBeenCalledTimes(1);
      expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
      expect(env.state.sessions.twitch.lastHeartbeatAt).toBe("2026-09-02T12:00:17.000Z");
      expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt)
        .toBe("2026-09-02T12:01:10.000Z");
      expect(aggregateHeartbeatDiagnostics(env, "twitch")).toEqual([
        expect.stringContaining(
          "scheduledDueAt=2026-09-02T12:00:10.000Z actualAttemptAt=2026-09-02T12:00:10.000Z",
        ),
      ]);
    });

    it("coalesces a scheduled alarm concurrent with an immediate heartbeat", async () => {
      vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
      const heartbeatResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
      const watcher = fakeTablessWatcher(() => heartbeatResult.promise);
      const env = handoffEnv({
        tablessMode: true,
        postClaimHandoffIntervalSeconds: 5,
      });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      let reveal = false;
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      reveal = true;
      await env.timer.flush();
      await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalledOnce());
      vi.setSystemTime(new Date("2026-09-02T12:01:05.000Z"));
      const alarm = env.controller.runWatchHeartbeat();
      await drainMicrotasks();

      expect(watcher.tick).toHaveBeenCalledOnce();
      heartbeatResult.resolve({ ok: true, live: true });
      await Promise.all([handoff, alarm]);
      expect(aggregateHeartbeatDiagnostics(env, "twitch")).toEqual([
        expect.stringContaining("coalescedCalls=1"),
      ]);
    });

    it("does not let a recent old-generation heartbeat suppress the switched target immediate heartbeat", async () => {
      vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
      const oldWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const nextWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: true });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = vi.fn()
        .mockReturnValueOnce(oldWatcher)
        .mockReturnValueOnce(nextWatcher);
      await env.controller.tick(["twitch"]);
      vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
      await env.controller.runWatchHeartbeat();
      expect(oldWatcher.tick).toHaveBeenCalledOnce();

      const nextCampaign: DropCampaign = {
        ...campaign("twitch"),
        rewards: [{ ...reward(), id: "next-reward" }],
      };
      vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([nextCampaign]);
      vi.setSystemTime(new Date("2026-09-02T12:01:05.000Z"));
      await env.controller.tick(["twitch"]);
      expect(env.state.sessions.twitch).toMatchObject({
        rewardId: "next-reward",
        lastHeartbeatAt: "2026-09-02T12:01:00.000Z",
      });

      await env.controller.runClaimHandoff("twitch", ["reward"]);

      expect(nextWatcher.tick).toHaveBeenCalledOnce();
      expect(env.state.sessions.twitch.tablessHeartbeat?.generation).toBe(2);
      expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt)
        .toBe("2026-09-02T12:02:05.000Z");
    });

    it("skips the immediate heartbeat when one just landed on the same channel", async () => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: true });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      // Both rewards visible from the start, so the triggering tick already
      // selects the successor and the handoff takes its fast path.
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(true)]);

      // Establish the tabless session and land a heartbeat seconds ago.
      await env.controller.tick();
      vi.setSystemTime(Date.now() + 60_000);
      await env.controller.runWatchHeartbeat();
      watcher.tick.mockClear();

      await env.controller.runClaimHandoff("twitch", ["reward-1"]);

      expect(watcher.tick).not.toHaveBeenCalled();
    });

    it("starts a handoff after an automatic claim", async () => {
      const env = handoffEnv();
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.tickAndHandOff();
      for (let index = 0; index < 12; index += 1) await env.timer.flush();
      const committed = await handoff;

      expect(env.timer.wait).toHaveBeenCalled();
      expect(committed).toEqual(env.state);
    });

    it("starts one handoff for a shared platform tick across overlapping batches", async () => {
      const kickRefresh = deferred<DropCampaign[]>();
      const env = handoffEnv({
        postClaimHandoffIntervalSeconds: 5,
        postClaimHandoffMaxSeconds: 15,
        platform: {
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
          kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true, idleWatchlistChannels: [] },
        },
      });
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);
      env.kick.refreshCampaigns = vi.fn(() => kickRefresh.promise);

      const twitchOnly = env.controller.tickAndHandOff(["twitch"]);
      const bothPlatforms = env.controller.tickAndHandOff();
      for (let index = 0; index < 6; index += 1) await env.timer.flush();
      await twitchOnly;
      kickRefresh.resolve([]);
      for (let index = 0; index < 6; index += 1) await env.timer.flush();
      await bothPlatforms;

      expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(4);
    });

    it("does not start a nested handoff for a claim inside a handoff", async () => {
      const env = handoffEnv({ postClaimHandoffIntervalSeconds: 5, postClaimHandoffMaxSeconds: 15 });
      // Every refresh yields another claimable reward, which would restart the
      // deadline forever if a nested handoff were allowed.
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      for (let index = 0; index < 10; index += 1) await env.timer.flush();
      await handoff;

      expect(env.timer.wait.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it("keeps an active handoff running during an ordinary settings save", async () => {
      const env = handoffEnv({ postClaimHandoffIntervalSeconds: 5, postClaimHandoffMaxSeconds: 15 });
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      await drainMicrotasks();
      expect(env.timer.parked).toBe(1);

      await env.controller.handleMessage({
        type: "saveSettings",
        settingsPatch: { notifyRewardEarned: false },
      });

      expect(env.timer.parked).toBe(1);
      for (let index = 0; index < 4; index += 1) await env.timer.flush();
      await handoff;
      expect(env.twitch.refreshCampaigns).toHaveBeenCalled();
    });

    it("aborts running handoffs when farming is switched off", async () => {
      const env = handoffEnv();
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      await drainMicrotasks();
      await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: false });
      await env.timer.flush();
      await handoff;

      expect(env.timer.parked).toBe(0);
    });

    it("does not start a second handoff while the first is still starting", async () => {
      const env = handoffEnv();
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      // Both calls are made before either has finished its async setup.
      const first = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      const second = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      await drainMicrotasks();
      env.controller.abortClaimHandoffs();
      await env.timer.flush();
      await Promise.all([first, second]);

      expect(env.timer.wait).toHaveBeenCalledTimes(1);
    });

    it("honors an abort issued while the handoff is still starting", async () => {
      const env = handoffEnv();
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(false)]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward-1"]);
      // Synchronously, before any setup await has resolved.
      env.controller.abortClaimHandoffs();
      await env.timer.flush();
      await handoff;

      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    });

    it("never refreshes after the maximum duration has elapsed", async () => {
      // A 30s interval against a 45s budget: a second full-length wait would
      // land a refresh at 60s, past the deadline the setting promises.
      const env = handoffEnv({ postClaimHandoffIntervalSeconds: 30, postClaimHandoffMaxSeconds: 45 });
      // The session keeps watching the reward that was just claimed, so the loop
      // never succeeds and never sees "nothing left" — only the deadline can end
      // it. Without that, the early exit would mask any overshoot.
      env.twitch.refreshCampaigns = vi.fn(async () => [campaign("twitch")]);

      const handoff = env.controller.runClaimHandoff("twitch", ["reward"]);
      for (let index = 0; index < 5; index += 1) await env.timer.flush();
      await handoff;

      expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(1);
    });

    it("sends no heartbeat when the abort lands while state is being read", async () => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: true });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(true)]);

      await env.controller.tick();
      watcher.tick.mockClear();

      // Cancel at the moment the successor becomes visible to the handoff.
      const loadState = env.deps.loadState.getMockImplementation()!;
      env.deps.loadState.mockImplementation(async () => {
        const state = await loadState();
        if (state.sessions.twitch.rewardId === "reward-2") env.controller.abortClaimHandoffs();
        return state;
      });

      await env.controller.runClaimHandoff("twitch", ["reward-1"]);

      expect(watcher.tick).not.toHaveBeenCalled();
    });

    it("sends no heartbeat when the next reward runs in a visible tab", async () => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = handoffEnv({ tablessMode: false });
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      let reveal = false;
      env.twitch.refreshCampaigns = vi.fn(async () => [chainedCampaign(reveal)]);

      const handoff = env.controller.runClaimHandoff("twitch");
      reveal = true;
      await env.timer.flush();
      await handoff;

      expect(watcher.tick).not.toHaveBeenCalled();
      // The tick that detected the successor already re-pointed the tab.
      expect(env.state.sessions.twitch.rewardId).toBe("reward-2");
      expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    });
  });
});
