import { describe, expect, it, vi } from "vitest";
import type { ChannelCandidate, DropCampaign, ExtensionSettings } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import type { TablessWatchController } from "@lurkloot/core/tablessWatch";
import {
  allDiagnostics,
  campaign,
  channel,
  deferred,
  dueHeartbeatCadence,
  farming,
  harness,
} from "../helpers/backgroundController";

// Discovery-signal controllers and the refreshes they request.

describe("discovery signal lifecycle", () => {
  function kickOnlySettings(tablessMode = false): ExtensionSettings {
    return {
      ...DEFAULT_SETTINGS,
      tablessMode,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
    };
  }

  function configureKickDiscoverySession(
    env: ReturnType<typeof harness>,
    categoryId = "42",
  ): void {
    vi.mocked(env.kick.listCandidateChannels).mockResolvedValue([
      channel("kick", { categoryId }),
    ]);
  }

  async function startKickDiscoverySession(env: ReturnType<typeof harness>): Promise<void> {
    configureKickDiscoverySession(env);
    await env.controller.tick(["kick"], "manual_tick");
    expect(env.state.sessions.kick).toMatchObject({
      status: "watching",
      channel: { categoryId: "42" },
    });
    expect(env.discoverySignalController.starts).toEqual([
      expect.objectContaining({
        platform: "kick",
        channel: expect.objectContaining({ categoryId: "42" }),
      }),
    ]);
  }

  it.each(["tab", "tabless"] as const)("starts the Kick observer for an active %s watch session", async (watchMode) => {
    const env = harness(kickOnlySettings(watchMode === "tabless"));
    configureKickDiscoverySession(env);
    if (watchMode === "tabless") {
      const watcher = {
        platform: "kick" as const,
        channelUrl: undefined as string | undefined,
        async start(candidate: ChannelCandidate) {
          watcher.channelUrl = candidate.url;
        },
        async tick() {
          return { ok: true, live: true };
        },
        drainEvents() {
          return [];
        },
        async stop() {
          watcher.channelUrl = undefined;
        },
      } satisfies TablessWatchController;
      env.kick.supportsTabless = true;
      env.kick.createTablessWatcher = () => watcher;
    }

    await env.controller.tick(["kick"], "manual_tick");

    expect(env.state.sessions.kick).toMatchObject({
      status: "watching",
      watchMode,
      channel: { categoryId: "42" },
    });
    expect(env.discoverySignalController.starts).toEqual([
      expect.objectContaining({
        platform: "kick",
        channel: expect.objectContaining({ categoryId: "42" }),
      }),
    ]);
  });

  it("does not create an observer for an idle session", async () => {
    const env = harness(kickOnlySettings());
    vi.mocked(env.kick.refreshCampaigns).mockResolvedValue([]);

    await env.controller.tick(["kick"], "manual_tick");

    expect(env.state.sessions.kick.status).toBe("idle");
    expect(env.discoverySignalFactory).not.toHaveBeenCalled();
    expect(env.discoverySignalController.starts).toEqual([]);
  });

  it.each(["disabled", "authentication_unhealthy"] as const)(
    "stops the observer when Kick becomes %s",
    async (transition) => {
      const env = harness(kickOnlySettings());
      await startKickDiscoverySession(env);

      if (transition === "disabled") {
        await env.controller.handleMessage({
          type: "setPlatformEnabled",
          platform: "kick",
          enabled: false,
        });
      } else {
        vi.mocked(env.kick.checkAuthHealth).mockResolvedValue({
          status: "invalid_credentials",
          checkedAt: "2026-08-12T12:00:00.000Z",
          reasonCode: "credentials_rejected",
          message: { key: "authInvalidCredentials" },
        });
        await env.controller.tick(["kick"], "manual_tick");
      }

      expect(env.discoverySignalController.stops).toBe(1);
      expect(env.discoverySignalController.targetKey).toBeUndefined();
      const refreshesAfterStop = vi.mocked(env.kick.refreshCampaigns).mock.calls.length;
      env.discoverySignalController.emitSignal();
      await env.controller.settleBackgroundWork();
      expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(refreshesAfterStop);
    },
  );

  it("stops the observer when adapter setup makes authentication unavailable", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    vi.mocked(env.deps.createAdapter).mockImplementation(() => {
      throw new Error("adapter setup failed");
    });

    await env.controller.tick(["kick"], "manual_tick");

    expect(env.state.authHealth.kick.status).toBe("unavailable");
    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.discoverySignalController.targetKey).toBeUndefined();
  });

  it("direct auth checks stop the observer and drop pending signal work when health becomes unhealthy", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    const activeRefresh = deferred<DropCampaign[]>();
    vi.mocked(env.kick.refreshCampaigns)
      .mockClear()
      .mockImplementationOnce(() => activeRefresh.promise);

    env.discoverySignalController.emitSignal();
    await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
    vi.mocked(env.kick.checkAuthHealth).mockClear().mockResolvedValue({
      status: "invalid_credentials",
      checkedAt: "2026-08-12T12:00:00.000Z",
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    });
    env.discoverySignalController.emitSignal();
    const checking = env.controller.checkAuthHealth("kick");

    activeRefresh.resolve([campaign("kick")]);
    await checking;
    await env.controller.settleBackgroundWork();

    expect(env.state.authHealth.kick.status).toBe("invalid_credentials");
    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();

    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();
    env.discoverySignalController.emitCapturedSignal();
    await env.controller.settleBackgroundWork();
    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("invalidating auth stops the observer while health is checking", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    await env.controller.invalidateAuthHealth("kick");

    expect(env.state.authHealth.kick.status).toBe("checking");
    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.discoverySignalController.targetKey).toBeUndefined();
    env.discoverySignalController.emitCapturedSignal();
    await env.controller.settleBackgroundWork();
    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("blocks signal admission before auth invalidation acquires the platform lock", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    const activeRefresh = deferred<DropCampaign[]>();
    vi.mocked(env.kick.refreshCampaigns)
      .mockClear()
      .mockImplementationOnce(() => activeRefresh.promise);
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    const ticking = env.controller.tick(["kick"], "manual_tick");
    await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    const invalidating = env.controller.invalidateAuthHealth("kick");
    env.discoverySignalController.emitSignal();

    activeRefresh.resolve([campaign("kick")]);
    await Promise.all([ticking, invalidating]);
    await env.controller.settleBackgroundWork();

    expect(env.state.authHealth.kick.status).toBe("checking");
    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
  });

  it("rechecks signal admission after loading settings and before launching a tick", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    const settingsRead = deferred<ExtensionSettings>();
    env.deps.loadSettings.mockClear();
    env.deps.loadSettings.mockImplementationOnce(() => settingsRead.promise);
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    env.discoverySignalController.emitSignal();
    await vi.waitFor(() => expect(env.deps.loadSettings).toHaveBeenCalledOnce());
    await env.controller.invalidateAuthHealth("kick");

    settingsRead.resolve(env.settings);
    await env.controller.settleBackgroundWork();

    expect(env.state.authHealth.kick.status).toBe("checking");
    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("does not reopen a paused signal loop after a healthy direct auth check", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    const settingsRead = deferred<ExtensionSettings>();
    env.deps.loadSettings.mockClear();
    env.deps.loadSettings.mockImplementationOnce(() => settingsRead.promise);
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    env.discoverySignalController.emitSignal();
    await vi.waitFor(() => expect(env.deps.loadSettings).toHaveBeenCalledOnce());
    await env.controller.checkAuthHealth("kick");
    expect(env.state.authHealth.kick.status).toBe("healthy");
    expect(env.discoverySignalController.stops).toBe(0);
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    settingsRead.resolve(env.settings);
    await env.controller.settleBackgroundWork();

    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();

    env.discoverySignalController.emitSignal();
    await env.controller.settleBackgroundWork();
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
  });

  it("does not transfer a paused signal loop to a restarted observer lifecycle", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    const settingsRead = deferred<ExtensionSettings>();
    env.deps.loadSettings.mockClear();
    env.deps.loadSettings.mockImplementationOnce(() => settingsRead.promise);
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    env.discoverySignalController.emitSignal();
    await vi.waitFor(() => expect(env.deps.loadSettings).toHaveBeenCalledOnce());
    vi.mocked(env.kick.checkAuthHealth).mockResolvedValue({
      status: "invalid_credentials",
      checkedAt: "2026-08-12T12:00:00.000Z",
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    });
    await env.controller.tick(["kick"], "manual_tick");
    expect(env.discoverySignalController.stops).toBe(1);

    vi.mocked(env.kick.checkAuthHealth).mockResolvedValue({
      status: "healthy",
      checkedAt: "2026-08-12T12:01:00.000Z",
    });
    await env.controller.tick(["kick"], "manual_tick");
    expect(env.discoverySignalController.starts).toHaveLength(2);
    expect(env.discoverySignalController.targetKey).toBe("42");
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    settingsRead.resolve(env.settings);
    await env.controller.settleBackgroundWork();

    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();

    env.discoverySignalController.emitSignal();
    await env.controller.settleBackgroundWork();
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
  });

  it("stops the observer when removing its active managed watch tab", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();

    await env.controller.handleTabRemoved(20);

    expect(env.state.sessions.kick).toMatchObject({
      status: "paused",
      reasonCode: "manual_tab_close",
    });
    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.discoverySignalController.targetKey).toBeUndefined();
    env.discoverySignalController.emitCapturedSignal();
    await env.controller.settleBackgroundWork();
    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("updates the observer when the watched channel category changes", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    vi.mocked(env.kick.refreshCampaigns).mockResolvedValue([
      { ...campaign("kick"), id: "kick-campaign-next" },
    ]);
    configureKickDiscoverySession(env, "84");
    vi.mocked(env.kick.checkChannel).mockImplementation(async (candidate) => ({
      live: true,
      categoryMatches: candidate.categoryId === "84",
      candidate,
    }));

    await env.controller.tick(["kick"], "manual_tick");

    expect(env.discoverySignalController.starts).toHaveLength(2);
    expect(env.discoverySignalController.starts[1]).toMatchObject({
      platform: "kick",
      channel: { categoryId: "84" },
    });
    expect(env.discoverySignalController.targetKey).toBe("84");
  });

  it.each(["reset", "shutdown"] as const)("stops observers during host %s", async (cleanup) => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);
    vi.mocked(env.kick.refreshCampaigns).mockClear();

    if (cleanup === "reset") {
      await env.controller.prepareForHostReset();
    } else {
      env.controller.shutdown();
    }
    await env.rawController.settleBackgroundWork();

    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.discoverySignalController.targetKey).toBeUndefined();
    env.discoverySignalController.emitSignal();
    await env.rawController.settleBackgroundWork();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("restarts the Kick observer after a host reset", async () => {
    const env = harness(kickOnlySettings());
    await startKickDiscoverySession(env);

    await env.controller.prepareForHostReset();
    await env.controller.tick(["kick"], "manual_tick");

    expect(env.discoverySignalController.stops).toBe(1);
    expect(env.discoverySignalController.starts).toHaveLength(2);
    expect(env.discoverySignalController.targetKey).toBe("42");
  });

  it("does not restore Kick discovery during tabless heartbeat restart recovery", async () => {
    const env = harness(kickOnlySettings(true));
    const watcher = {
      platform: "kick" as const,
      channelUrl: undefined as string | undefined,
      start: vi.fn(async (candidate: ChannelCandidate) => {
        watcher.channelUrl = candidate.url;
      }),
      tick: vi.fn(async () => ({ ok: true, live: true })),
      drainEvents: () => [],
      stop: vi.fn(async () => {
        watcher.channelUrl = undefined;
      }),
    } satisfies TablessWatchController;
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    env.state.authHealth.kick = { status: "healthy" };
    env.state.sessions.kick = {
      platform: "kick",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("kick", { categoryId: "42" }),
      campaignId: "kick-campaign",
      rewardId: "reward",
    };
    env.state.sessions.kick.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.kick);

    await env.controller.runWatchHeartbeat();

    expect(watcher.start).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: "42" }),
      expect.any(Object),
    );
    expect(watcher.tick).toHaveBeenCalledOnce();
    expect(env.discoverySignalController.starts).toEqual([]);
  });

  it("does not make discovery failure count as a watch-heartbeat failure", async () => {
    const env = harness(kickOnlySettings(true));
    configureKickDiscoverySession(env);
    const watcher = {
      platform: "kick" as const,
      channelUrl: undefined as string | undefined,
      async start(candidate: ChannelCandidate) {
        watcher.channelUrl = candidate.url;
      },
      async tick() {
        return { ok: true, live: true };
      },
      drainEvents() {
        return [];
      },
      async stop() {
        watcher.channelUrl = undefined;
      },
    } satisfies TablessWatchController;
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = () => watcher;
    env.discoverySignalController.pushDiagnostic("observer transport unavailable");
    vi.spyOn(env.discoverySignalController, "start").mockRejectedValueOnce(
      new Error("observer start failed"),
    );

    await env.controller.tick(["kick"], "manual_tick");

    expect(env.state.sessions.kick).toMatchObject({
      status: "watching",
      watchMode: "tabless",
    });
    expect(env.state.sessions.kick.heartbeatChecks).toBe(0);
    expect(env.state.sessions.kick.lastHeartbeatOk).toBeUndefined();
    expect(allDiagnostics(env)).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: "kick", message: "observer transport unavailable" }),
      expect.objectContaining({ platform: "kick", message: "observer start failed" }),
    ]));
  });
});

describe("discovery signal refresh scheduling", () => {
  function kickOnlySettings(): ExtensionSettings {
    return {
      ...DEFAULT_SETTINGS,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
    };
  }

  async function startedEnv() {
    const env = harness(kickOnlySettings());
    vi.mocked(env.kick.listCandidateChannels).mockResolvedValue([
      channel("kick", { categoryId: "42" }),
    ]);
    await env.controller.tick(["kick"], "manual_tick");
    expect(env.discoverySignalController.targetKey).toBe("42");
    return env;
  }

  it("turns a Kick discovery signal into a Kick-only canonical tick", async () => {
    const env = await startedEnv();
    vi.mocked(env.kick.refreshCampaigns).mockClear();
    vi.mocked(env.kick.checkAuthHealth).mockClear();
    env.discoverySignalController.pushDiagnostic("observer warning between ticks");

    env.discoverySignalController.emitSignal();
    await env.controller.settleBackgroundWork();

    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
      platform: "kick",
      message: "observer warning between ticks",
    }));
  });

  it("coalesces a burst into one pending Kick refresh", async () => {
    const env = await startedEnv();
    const firstRefresh = deferred<DropCampaign[]>();
    const secondRefresh = deferred<DropCampaign[]>();
    let activeRefreshes = 0;
    let maximumActiveRefreshes = 0;
    const blockOn = async (pending: ReturnType<typeof deferred<DropCampaign[]>>) => {
      activeRefreshes += 1;
      maximumActiveRefreshes = Math.max(maximumActiveRefreshes, activeRefreshes);
      try {
        return await pending.promise;
      } finally {
        activeRefreshes -= 1;
      }
    };
    vi.mocked(env.kick.refreshCampaigns)
      .mockClear()
      .mockImplementationOnce(() => blockOn(firstRefresh))
      .mockImplementationOnce(() => blockOn(secondRefresh));
    vi.mocked(env.twitch.refreshCampaigns).mockClear();

    env.discoverySignalController.emitSignal();
    await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
    env.discoverySignalController.emitSignal();
    env.discoverySignalController.emitSignal();
    env.discoverySignalController.emitSignal();

    try {
      firstRefresh.resolve([campaign("kick")]);
      await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(2));
      expect(activeRefreshes).toBe(1);
    } finally {
      firstRefresh.resolve([campaign("kick")]);
      secondRefresh.resolve([campaign("kick")]);
      await env.controller.settleBackgroundWork();
    }

    expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(2);
    expect(maximumActiveRefreshes).toBe(1);
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("runs exactly one follow-up when a signal arrives during an active Kick tick", async () => {
    const env = await startedEnv();
    const activeRefresh = deferred<DropCampaign[]>();
    vi.mocked(env.kick.refreshCampaigns)
      .mockClear()
      .mockImplementationOnce(() => activeRefresh.promise);

    const ticking = env.controller.tick(["kick"], "manual_tick");
    await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
    env.discoverySignalController.emitSignal();

    activeRefresh.resolve([campaign("kick")]);
    await ticking;
    await env.controller.settleBackgroundWork();

    expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(2);
    expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
      message: "Coalesced scheduler triggers (count=1, reasons=discovery_signal:1)",
    }));
  });

  it("merges discovery signals and pending alarms into the same follow-up", async () => {
    const env = await startedEnv();
    const discovery = deferred<DropCampaign[]>();
    vi.mocked(env.kick.refreshCampaigns).mockClear().mockReturnValueOnce(discovery.promise);
    const first = env.controller.tick(["kick"], "alarm");
    await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
    const pending = env.controller.tick(["kick"], "alarm");
    env.discoverySignalController.emitSignal();
    env.discoverySignalController.emitSignal();
    discovery.resolve([campaign("kick")]);
    await Promise.all([first, pending]);
    await env.controller.settleBackgroundWork();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "alarm", "manual_tick"] as const)("invalidates an admitted signal while retaining an independent %s trigger", async (independentTrigger) => {
    const env = await startedEnv();
    const settingsRead = deferred<ExtensionSettings>();
    const settingsReadStarted = deferred<void>();
    const discovery = deferred<DropCampaign[]>();
    env.deps.loadSettings.mockImplementationOnce(() => {
      settingsReadStarted.resolve();
      return settingsRead.promise;
    });
    env.discoverySignalController.emitSignal();
    await settingsReadStarted.promise;
    vi.mocked(env.kick.refreshCampaigns).mockClear().mockReturnValueOnce(discovery.promise);
    env.reportEvents.mockClear();
    const first = env.controller.tick(["kick"], "alarm");
    let independent: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
      settingsRead.resolve(env.settings);
      // Let the paused signal finish admission behind the blocked alarm.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (independentTrigger) independent = env.controller.tick(["kick"], independentTrigger);
      await env.controller.invalidateAuthHealth("kick");
      discovery.resolve([campaign("kick")]);
      await Promise.all([first, independent]);
      await env.controller.settleBackgroundWork();

      expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(independentTrigger ? 2 : 1);
      const starts = allDiagnostics(env).filter((event) => /Tick #\d+ started/.test(event.message));
      expect(starts).toHaveLength(independentTrigger ? 2 : 1);
      if (independentTrigger) expect(starts.at(-1)?.message).toContain(`trigger=${independentTrigger}`);
    } finally {
      settingsRead.resolve(env.settings);
      discovery.resolve([campaign("kick")]);
      await Promise.allSettled([first, independent]);
      await env.controller.settleBackgroundWork();
    }
  });

  it("coalesces bursts before and after an ordinary Kick tick fetch into one non-overlapping follow-up", async () => {
    const env = await startedEnv();
    const ordinaryAuth = deferred<void>();
    const ordinaryRefresh = deferred<DropCampaign[]>();
    let authCalls = 0;
    let activeAuthProbes = 0;
    let maximumActiveAuthProbes = 0;
    vi.mocked(env.kick.checkAuthHealth)
      .mockClear()
      .mockImplementation(async () => {
        authCalls += 1;
        activeAuthProbes += 1;
        maximumActiveAuthProbes = Math.max(maximumActiveAuthProbes, activeAuthProbes);
        try {
          if (authCalls === 1) await ordinaryAuth.promise;
          return { status: "healthy", checkedAt: "2026-08-12T12:00:00.000Z" };
        } finally {
          activeAuthProbes -= 1;
        }
      });
    vi.mocked(env.kick.refreshCampaigns)
      .mockClear()
      .mockImplementationOnce(() => ordinaryRefresh.promise)
      .mockResolvedValue([campaign("kick")]);

    const ticking = env.controller.tick(["kick"], "manual_tick");
    try {
      await vi.waitFor(() => expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce());
      env.discoverySignalController.emitSignal();
      env.discoverySignalController.emitSignal();
      env.discoverySignalController.emitSignal();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();

      ordinaryAuth.resolve();
      await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
      env.discoverySignalController.emitSignal();
      env.discoverySignalController.emitSignal();
      env.discoverySignalController.emitSignal();
      ordinaryRefresh.resolve([campaign("kick")]);

      await ticking;
      await env.controller.settleBackgroundWork();

      expect(env.kick.checkAuthHealth).toHaveBeenCalledTimes(2);
      expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(2);
      expect(maximumActiveAuthProbes).toBe(1);
    } finally {
      ordinaryAuth.resolve();
      ordinaryRefresh.resolve([campaign("kick")]);
      await Promise.allSettled([ticking]);
      await env.controller.settleBackgroundWork();
    }
  });

  it("keeps Twitch refresh calls unchanged by a Kick signal", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    vi.mocked(env.kick.listCandidateChannels).mockResolvedValue([
      channel("kick", { categoryId: "42" }),
    ]);
    await env.controller.tick(undefined, "manual_tick");
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();

    env.discoverySignalController.emitSignal();
    await env.controller.settleBackgroundWork();

    expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(2);
  });

  it.each(["disablement", "shutdown"] as const)("drops pending signal work after %s", async (cleanup) => {
    const env = await startedEnv();
    const activeRefresh = deferred<DropCampaign[]>();
    vi.mocked(env.kick.refreshCampaigns)
      .mockClear()
      .mockImplementationOnce(() => activeRefresh.promise);

    env.discoverySignalController.emitSignal();
    await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
    env.discoverySignalController.emitSignal();

    if (cleanup === "disablement") {
      await env.rawController.handleMessage({
        type: "setPlatformEnabled",
        platform: "kick",
        enabled: false,
      });
    } else {
      env.controller.shutdown();
    }
    activeRefresh.resolve([campaign("kick")]);
    await env.rawController.settleBackgroundWork();

    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
    expect(env.discoverySignalController.stops).toBe(1);
  });

  it("records discovery_signal in tick lifecycle diagnostics", async () => {
    const env = await startedEnv();
    env.reportEvents.mockClear();

    env.discoverySignalController.emitSignal();
    await env.controller.settleBackgroundWork();

    const messages = allDiagnostics(env).map((event) => event.message);
    expect(messages).toContainEqual(expect.stringContaining("started (trigger=discovery_signal"));
    expect(messages).toContainEqual(expect.stringContaining("finished after"));
    expect(messages).toContainEqual(expect.stringContaining("trigger=discovery_signal"));
  });
});
