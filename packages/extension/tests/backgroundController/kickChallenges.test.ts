import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchedulerState } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "../../src/core/storage";
import { currentManagedPageContextTabs, registerManagedPageContextTabs } from "@lurkloot/core/tabs";
import { deferred, farming, harness, tablessEnv } from "../helpers/backgroundController";

// Kick page-context recovery.

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconciles one Kick route observation only after the scheduler cycle persists", async () => {
    const order: string[] = [];
    let countBackgroundSuccess: boolean | undefined;
    let observedThreshold: number | undefined;
    const env = harness(farming(DEFAULT_SETTINGS), {
      saveState: async () => { order.push("persist"); },
      initialState: {
        ...structuredClone(DEFAULT_STATE),
        authHealth: { ...DEFAULT_STATE.authHealth, kick: { status: "healthy" } },
      },
      reconcilePageContextRecovery: async (_platform, settings, options) => {
        order.push("reconcile");
        observedThreshold = settings.kickPageContextRecoverySuccesses;
        countBackgroundSuccess = options.countBackgroundSuccess;
        return false;
      },
    });

    await env.controller.tick(["kick"]);

    expect(order[0]).toBe("persist");
    expect(order).toContain("reconcile");
    expect(observedThreshold).toBe(3);
    expect(countBackgroundSuccess).toBe(true);
    expect(env.deps.reconcilePageContextRecovery).toHaveBeenCalledTimes(1);
  });

  it("reconciles retained Kick route evidence after a failed discovery state persists", async () => {
    let countBackgroundSuccess: boolean | undefined;
    const reconcile = vi.fn(async (_platform, _settings, options) => {
      countBackgroundSuccess = options.countBackgroundSuccess;
      return false;
    });
    const env = harness(farming(DEFAULT_SETTINGS), { reconcilePageContextRecovery: reconcile });
    env.kick.refreshCampaigns = vi.fn(async () => { throw new Error("discovery failed"); });

    await env.controller.tick(["kick"]);

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
    registerManagedPageContextTabs({ twitch: newerContext });
    staleRead.resolve(staleState);
    try {
      await heartbeat;
      expect(currentManagedPageContextTabs().twitch).toEqual(newerContext);
    } finally {
      registerManagedPageContextTabs({});
    }
  });
});
