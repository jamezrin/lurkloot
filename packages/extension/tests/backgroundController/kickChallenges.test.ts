import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchedulerState } from "@lurkloot/shared/models";
import type { ClaimedChallenge } from "@lurkloot/core/adapter";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "../../src/core/storage";
import { createTabRegistry, currentManagedPageContextTabs, noteTabClosure, registerManagedPageContextTabs } from "@lurkloot/core/tabRegistry";
import { channel, deferred, farming, harness, tablessEnv } from "../helpers/backgroundController";

// The Kick runtime (#588): page-context recovery and the challenge job.

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconciles one Kick route observation only after the scheduler cycle persists", async () => {
    const order: string[] = [];
    let countBackgroundSuccess: boolean | undefined;
    const env = harness(farming(DEFAULT_SETTINGS), {
      saveState: async () => { order.push("persist"); },
      initialState: {
        ...structuredClone(DEFAULT_STATE),
        authHealth: { ...DEFAULT_STATE.authHealth, kick: { status: "healthy" } },
      },
      reconcilePageContextRecovery: async (_platform, options) => {
        order.push("reconcile");
        countBackgroundSuccess = options.countBackgroundSuccess;
        return false;
      },
    });

    await env.controller.tick(["kick"]);

    expect(order[0]).toBe("persist");
    expect(order).toContain("reconcile");
    expect(countBackgroundSuccess).toBe(true);
    expect(env.deps.reconcilePageContextRecovery).toHaveBeenCalledTimes(1);
  });

  it("reconciles retained Kick route evidence after a failed discovery state persists", async () => {
    let countBackgroundSuccess: boolean | undefined;
    const reconcile = vi.fn(async (_platform, options) => {
      countBackgroundSuccess = options.countBackgroundSuccess;
      return false;
    });
    const env = harness(farming(DEFAULT_SETTINGS), { reconcilePageContextRecovery: reconcile });
    env.kick.refreshCampaigns = vi.fn(async () => { throw new Error("discovery failed"); });

    await env.controller.tick(["kick"]);

    expect(reconcile).toHaveBeenCalledOnce();
    expect(countBackgroundSuccess).toBe(false);
  });

  it("does not count direct successes from a committed cycle whose farming failed", async () => {
    let countBackgroundSuccess: boolean | undefined;
    const reconcile = vi.fn(async (_platform, options) => {
      countBackgroundSuccess = options.countBackgroundSuccess;
      return false;
    });
    const env = harness(farming(DEFAULT_SETTINGS), {
      reconcilePageContextRecovery: reconcile,
      initialState: {
        ...structuredClone(DEFAULT_STATE),
        authHealth: { ...DEFAULT_STATE.authHealth, kick: { status: "healthy" } },
      },
    });
    vi.mocked(env.kick.listCandidateChannels).mockResolvedValue([channel("kick")]);
    env.watchTabs.kick.open.mockRejectedValueOnce(new Error("tab unavailable"));

    await env.controller.tick(["kick"]);

    expect(env.state.sessions.kick).toMatchObject({ status: "error", errorChecks: 1 });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(countBackgroundSuccess).toBe(false);
  });

  it("discards route evidence when an aborted tick cannot persist", async () => {
    const discard = vi.fn();
    const env = harness(farming(DEFAULT_SETTINGS), {
      discardPageContextRecoveryEvidence: discard,
      initialState: {
        ...structuredClone(DEFAULT_STATE),
        authHealth: { ...DEFAULT_STATE.authHealth, kick: { status: "healthy" } },
      },
    });
    const refreshStarted = deferred<void>();
    env.kick.refreshCampaigns = vi.fn(async (_session, options) => {
      refreshStarted.resolve();
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
      return [];
    });

    const tick = env.controller.tick(["kick"]);
    await refreshStarted.promise;
    env.controller.shutdown();
    await tick;

    expect(discard).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledWith("kick");
  });

  it.each(["extension-recovery", "extension-cleanup"] as const)(
    "does not pause Kick when it closes its own page context (%s)",
    async (origin) => {
      const tabRegistry = createTabRegistry();
      const env = harness(farming(DEFAULT_SETTINGS), { tabRegistry });
      env.state.managedPageContextTabs = {
        kick: {
          platform: "kick",
          tabId: 66,
          originUrl: "https://kick.com/",
          origin: "https://kick.com",
          ownedByExtension: true,
        },
      };
      const sessionBefore = structuredClone(env.state.sessions.kick);
      noteTabClosure(tabRegistry, 66, origin);

      await env.controller.handleTabRemoved(66);

      expect(env.state.manualClosePause?.kick).toBeUndefined();
      expect(env.state.sessions.kick).toEqual(sessionBefore);
    },
  );

  it("does not hydrate an old persisted page context over a newer registry update", async () => {
    const staleRead = deferred<SchedulerState>();
    const env = tablessEnv();
    const oldContext = {
      platform: "twitch" as const,
      tabId: 66,
      originUrl: "https://www.twitch.tv/old-context",
      origin: "https://www.twitch.tv",
      ownedByExtension: true as const,
    };
    const newerContext = {
      ...oldContext,
      tabId: 77,
      originUrl: "https://www.twitch.tv/newer-context",
      lastFallbackAt: "2026-09-02T12:00:00.000Z",
      fallbackHost: "gql.twitch.tv",
      backgroundSuccesses: 0,
    };
    const staleState = structuredClone(env.state);
    staleState.managedPageContextTabs = { twitch: oldContext };
    env.deps.loadState
      .mockImplementationOnce(() => staleRead.promise)
      .mockResolvedValue(env.state);

    const heartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(env.deps.loadState).toHaveBeenCalled());
    registerManagedPageContextTabs(env.tabRegistry, { twitch: newerContext });
    staleRead.resolve(staleState);
    await heartbeat;
    expect(currentManagedPageContextTabs(env.tabRegistry).twitch).toEqual(newerContext);
  });

  describe("Kick challenge job", () => {
    // Kick paused for a manual watch in tab 92, which is when the job claims.
    function watchingKickByHand(env: ReturnType<typeof harness>): void {
      env.state.authHealth = {
        ...env.state.authHealth,
        kick: { status: "healthy", checkedAt: new Date().toISOString() },
      };
      env.state.sessions.kick = { platform: "kick", status: "paused", offlineChecks: 0, reasonCode: "manual_watch" };
      env.state.manualWatch = {
        kick: { platform: "kick", tabId: 92, checkedAt: new Date().toISOString(), active: true },
      };
    }

    it("claims with no lock held and commits only its poll stamp onto the latest state", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      watchingKickByHand(env);
      const challenges = deferred<ClaimedChallenge[]>();
      env.kick.claimChallenges = vi.fn(async () => challenges.promise);

      const claiming = env.controller.runKickChallengeClaims();
      await vi.waitFor(() => expect(env.kick.claimChallenges).toHaveBeenCalledOnce());
      // The user closes the watched tab while the claim is in flight. That
      // commit takes the state lock, so it only finishes if the job holds none.
      await env.controller.handleTabRemoved(92);
      const afterClose = structuredClone(env.state.manualWatch);
      expect(afterClose).not.toEqual({
        kick: expect.objectContaining({ tabId: 92, active: true }),
      });
      challenges.resolve([{ id: "daily", rarity: "epic", recurrence: "daily" }]);
      await claiming;

      expect(env.state.manualWatch).toEqual(afterClose);
      expect(env.state.gamification?.kick?.lastCheckedAt).toBeDefined();
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
        category: "activity",
        code: "challenge_claimed",
        platform: "kick",
      }));
    });

    it("sends one claim request when the job fires again while its claim is in flight", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      watchingKickByHand(env);
      const challenges = deferred<ClaimedChallenge[]>();
      env.kick.claimChallenges = vi.fn(async () => challenges.promise);

      const first = env.controller.runKickChallengeClaims();
      await vi.waitFor(() => expect(env.kick.claimChallenges).toHaveBeenCalledOnce());
      await env.controller.runKickChallengeClaims();
      challenges.resolve([{ id: "daily", rarity: "epic", recurrence: "daily" }]);
      await first;

      expect(env.kick.claimChallenges).toHaveBeenCalledOnce();
      expect(env.reportEvents.mock.calls.flatMap(([events]) => events).filter(
        (event) => event.category === "activity" && event.code === "challenge_claimed",
      )).toHaveLength(1);
    });

    it("skips its claim while the tick's claim is in flight", async () => {
      const env = harness(farming(DEFAULT_SETTINGS), {
        initialState: {
          ...structuredClone(DEFAULT_STATE),
          authHealth: { ...DEFAULT_STATE.authHealth, kick: { status: "healthy" } },
        },
      });
      const challenges = deferred<ClaimedChallenge[]>();
      env.kick.claimChallenges = vi.fn(async () => challenges.promise);

      const ticking = env.controller.tick(["kick"]);
      await vi.waitFor(() => expect(env.kick.claimChallenges).toHaveBeenCalledOnce());
      // The user starts watching Kick by hand, which is when the job claims.
      watchingKickByHand(env);
      await env.controller.runKickChallengeClaims();

      expect(env.kick.claimChallenges).toHaveBeenCalledOnce();
      challenges.resolve([]);
      await ticking;
    });

    it("keeps a newer poll stamp committed while its claim was in flight", async () => {
      const env = harness(farming(DEFAULT_SETTINGS));
      watchingKickByHand(env);
      const challenges = deferred<ClaimedChallenge[]>();
      env.kick.claimChallenges = vi.fn(async () => challenges.promise);

      const claiming = env.controller.runKickChallengeClaims();
      await vi.waitFor(() => expect(env.kick.claimChallenges).toHaveBeenCalledOnce());
      const newer = new Date(Date.now() + 60_000).toISOString();
      env.state.gamification = { kick: { lastCheckedAt: newer } };
      challenges.resolve([]);
      await claiming;

      expect(env.state.gamification?.kick?.lastCheckedAt).toBe(newer);
    });
  });
});
