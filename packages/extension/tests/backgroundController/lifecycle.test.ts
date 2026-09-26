import { afterEach, describe, expect, it, vi } from "vitest";
import { ALARM_NAME, KICK_ALARM_NAME, TWITCH_ALARM_NAME } from "@lurkloot/core/controller";
import { DEFAULT_SETTINGS, isFarmingActive } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "../../src/core/storage";
import {
  asSnapshot,
  campaign,
  channel,
  deferred,
  farming,
  harness,
  notFarming,
  reward,
} from "../helpers/backgroundController";

// Startup, jobs, shutdown and host reset.

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates the scheduler alarm from persisted settings", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pollIntervalMinutes: 11 }));

    await env.controller.ensureAlarm();

    expect(env.deps.clearAlarm).toHaveBeenCalledWith(ALARM_NAME);
    expect(env.deps.createAlarm).toHaveBeenCalledWith(TWITCH_ALARM_NAME, { periodInMinutes: 11 });
    expect(env.deps.createAlarm).toHaveBeenCalledWith(KICK_ALARM_NAME, { periodInMinutes: 11 });
  });

  it("stamps the install time once through the serialized controller lifecycle", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.ensureInstalledAt("2026-07-26T12:00:00.000Z");
    await env.controller.ensureInstalledAt("2026-07-26T13:00:00.000Z");

    expect(env.state.installedAt).toBe("2026-07-26T12:00:00.000Z");
  });

  it("preserves a state write that lands while startup setup reporting is pending", async () => {
    const setupReported = deferred<void>();
    const env = harness(
      farming(DEFAULT_SETTINGS),
      { reportEvents: async () => setupReported.promise },
    );
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 44,
      tabManagedByExtension: true,
    };

    const startup = env.controller.handleStartup();
    await vi.waitFor(() => expect(env.reportEvents).toHaveBeenCalled());
    await env.deps.saveState({
      ...env.state,
      installedAt: "2026-07-26T12:00:00.000Z",
    });
    setupReported.resolve();
    await startup;

    expect(env.state.installedAt).toBe("2026-07-26T12:00:00.000Z");
  });

  it("preserves a settings patch that lands while startup setup reporting is pending", async () => {
    const setupReported = deferred<void>();
    const env = harness(
      farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true }),
      { reportEvents: async () => setupReported.promise },
    );

    const startup = env.controller.handleStartup();
    await vi.waitFor(() => expect(env.reportEvents).toHaveBeenCalled());
    await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { diagnosticLogging: false },
      tickAfterSave: false,
    });
    setupReported.resolve();
    await startup;

    expect(isFarmingActive(env.settings)).toBe(true);
    expect(env.settings.diagnosticLogging).toBe(false);
  });

  it("refreshes enabled auth health from ensureAlarm while farming is stopped", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      autoStartDropFarming: false,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });

    await env.controller.ensureAlarm();

    expect(env.state.authHealth.twitch.status).toBe("healthy");
    expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
  });

  // Auth health is only probed for enabled platforms, and auto-start off now
  // disables them on launch — so startup neither farms nor probes, and the popup
  // reports auth once the user switches a platform back on.
  it("neither farms nor probes on startup when auto-start disabled every platform", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: false }));

    await env.controller.handleStartup();

    expect(isFarmingActive(env.settings)).toBe(false);
    expect(env.twitch.checkAuthHealth).not.toHaveBeenCalled();
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("refreshes enabled auth health on startup while auto-start keeps farming", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true }));

    await env.controller.handleStartup();

    expect(env.state.authHealth.twitch.status).toBe("healthy");
    expect(env.state.authHealth.kick.status).toBe("healthy");
  });

  it("auto-starts on launch only when a platform is enabled", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true }));

    await env.controller.ensureAlarm();

    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
  });

  it("clears stale restart tabs and auto-resumes with fresh tabs when auto-start is enabled", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true }));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      campaignId: "old-campaign",
      rewardId: "old-reward",
      offlineChecks: 2,
      playbackChecks: 1,
      errorChecks: 1,
      retryAfter: new Date(Date.now() + 60_000).toISOString(),
      tabId: 44,
      tabManagedByExtension: true,
      playback: {
        platform: "twitch",
        checkedAt: new Date().toISOString(),
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    };
    env.state.campaigns.twitch = [{
      ...campaign("twitch"),
      id: "old-campaign",
      rewards: [{ ...reward(), id: "old-reward" }],
    }];
    env.state.managedWatchTabs = {
      twitch: {
        platform: "twitch",
        tabId: 44,
        channelUrl: "https://www.twitch.tv/twitch-creator",
        ownedByExtension: true,
      },
    };

    await env.controller.handleStartup();

    expect(env.deps.createAlarm).toHaveBeenCalledWith(TWITCH_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.createAlarm).toHaveBeenCalledWith(KICK_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.closeManagedTabs).toHaveBeenCalledWith([
      expect.objectContaining({ tabId: 44, channelUrl: "https://www.twitch.tv/twitch-creator", ownedByExtension: true }),
    ]);
    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    expect(env.twitch.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce();
    expect(env.state.sessions.twitch.status).toBe("watching");
    expect(env.state.sessions.twitch.tabId).toBe(10);
    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        category: "activity",
        code: "farming_stopped",
        data: expect.objectContaining({ reason: "runtime_restart" }),
      }),
    ]));
  });

  it("pauses stale restart sessions and disables running when auto-start is disabled", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: false }));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 44,
      tabManagedByExtension: true,
    };
    env.state.managedWatchTabs = {
      twitch: {
        platform: "twitch",
        tabId: 44,
        channelUrl: "https://www.twitch.tv/twitch-creator",
        ownedByExtension: true,
      },
    };

    await env.controller.handleStartup();

    expect(isFarmingActive(env.settings)).toBe(false);
    expect(env.deps.closeManagedTabs).toHaveBeenCalledWith([
      expect.objectContaining({ tabId: 44, channelUrl: "https://www.twitch.tv/twitch-creator", ownedByExtension: true }),
    ]);
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.managedWatchTabs).toEqual({});
    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      tabId: undefined,
      tabManagedByExtension: undefined,
      message: "Browser restarted; farming paused",
    });
  });

  it("cleans stale restart state without starting farming when automation is already stopped", async () => {
    const env = harness(notFarming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true }));
    env.state.sessions.kick = {
      platform: "kick",
      status: "paused",
      channel: channel("kick"),
      offlineChecks: 0,
      tabId: 55,
      tabManagedByExtension: true,
    };
    env.state.managedWatchTabs = {
      kick: {
        platform: "kick",
        tabId: 55,
        channelUrl: "https://kick.com/kick-creator",
        ownedByExtension: true,
      },
    };

    await env.controller.handleStartup();

    expect(isFarmingActive(env.settings)).toBe(false);
    expect(env.deps.closeManagedTabs).toHaveBeenCalledWith([
      expect.objectContaining({ tabId: 55, channelUrl: "https://kick.com/kick-creator", ownedByExtension: true }),
    ]);
    expect(env.kick.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.sessions.kick.status).toBe("paused");
    expect(env.state.sessions.kick.tabId).toBeUndefined();
  });

  it("clears stale retained page-context tabs on startup", async () => {
    const env = harness(notFarming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true }));
    env.state.managedPageContextTabs = {
      twitch: {
        platform: "twitch",
        tabId: 66,
        originUrl: "https://www.twitch.tv/drops/inventory",
        origin: "https://www.twitch.tv",
        ownedByExtension: true,
      },
    };

    await env.controller.handleStartup();

    expect(env.deps.closeManagedTabs).not.toHaveBeenCalled();
    expect(env.deps.stopPageContextTabs).toHaveBeenCalledWith(
      expect.objectContaining({ twitch: expect.objectContaining({ tabId: 66 }) }),
      expect.objectContaining({ platforms: ["twitch", "kick"], reason: "runtime_restart", emit: expect.any(Function) }),
    );
    expect(env.state.managedPageContextTabs).toEqual({});
    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      tabId: undefined,
      message: "Browser restarted; farming paused",
    });
  });

  it("preserves a retained Kick page context across a running service-worker restart", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      autoStartDropFarming: true,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false, idleWatchlistChannels: [] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
    });
    const context = {
      platform: "kick" as const,
      tabId: 91,
      originUrl: "https://kick.com/drops/inventory",
      origin: "https://kick.com",
      ownedByExtension: true as const,
      lastFallbackAt: "2026-07-22T08:00:00.000Z",
      fallbackHost: "web.kick.com",
      backgroundSuccesses: 0,
    };
    env.state.managedPageContextTabs = { kick: context };

    await env.controller.handleStartup();

    expect(env.deps.stopPageContextTabs).not.toHaveBeenCalledWith(
      expect.objectContaining({ kick: expect.objectContaining({ tabId: 91 }) }),
      expect.objectContaining({ reason: "runtime_restart" }),
    );
    expect(env.state.managedPageContextTabs?.kick).toEqual(context);
    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
  });

  it("does not log startup cleanup when there is no stale farming state", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: true }));

    await env.controller.handleStartup();

    expect(env.deps.createAlarm).toHaveBeenCalledWith(TWITCH_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.createAlarm).toHaveBeenCalledWith(KICK_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.closeManagedTabs).not.toHaveBeenCalled();
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events).some((event) =>
      event.category === "diagnostic" && event.message.includes("Browser restarted")
    )).toBe(false);
  });

  it("disables every platform on startup when auto-start is disabled even without stale tabs", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoStartDropFarming: false }));

    await env.controller.handleStartup();

    expect(isFarmingActive(env.settings)).toBe(false);
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("starts automation, persists settings, creates alarm, and runs an immediate tick", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true }));

    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.deps.createAlarm).toHaveBeenCalledWith(TWITCH_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.createAlarm).toHaveBeenCalledWith(KICK_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    // The snapshot returns ahead of the tick, reporting the prompt "starting"
    // transition; the watching status lands once the tick settles.
    expect(snapshot.state.sessions.twitch.status).toBe("starting");
    expect(env.state.sessions.twitch.status).toBe("watching");
  });

  it("stops automation immediately and applies auto-close behavior to active watch tabs", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoCloseFinishedDrops: false }));
    await env.controller.tick();
    env.state.managedPageContextTabs = {
      twitch: {
        platform: "twitch",
        tabId: 66,
        originUrl: "https://www.twitch.tv/drops/inventory",
        origin: "https://www.twitch.tv",
        ownedByExtension: true,
      },
    };

    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: false });
    await env.controller.handleMessage({ type: "setAutomation", platform: "kick", enabled: false });

    expect(isFarmingActive(env.settings)).toBe(false);
    expect(env.twitch.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 10 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(env.kick.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 20 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // Read from settled state rather than the returned snapshot: the snapshot is
    // now taken before the tick that applies the stop.
    expect(env.state.sessions.twitch.status).toBe("paused");
    expect(env.state.sessions.kick.status).toBe("paused");
    expect(env.state.managedPageContextTabs?.twitch).toBeUndefined();
  });

  it("prepares a host reset by force-closing managed tabs", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoCloseFinishedDrops: false }));
    await env.controller.tick();
    env.state.managedPageContextTabs = {
      twitch: {
        platform: "twitch",
        tabId: 66,
        originUrl: "https://www.twitch.tv/drops/inventory",
        origin: "https://www.twitch.tv",
        ownedByExtension: true,
      },
    };

    await env.controller.prepareForHostReset();

    expect(env.twitch.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 10 }),
      expect.objectContaining({ closeManagedTabs: true }),
    );
    expect(env.kick.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 20 }),
      expect.objectContaining({ closeManagedTabs: true }),
    );
    expect(env.deps.stopPageContextTabs).toHaveBeenCalledWith(
      expect.objectContaining({ twitch: expect.objectContaining({ tabId: 66 }) }),
      expect.objectContaining({ platforms: ["twitch", "kick"], emit: expect.any(Function) }),
    );
  });

  it("preempts an in-flight scheduler tick before resetting host storage", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    let tickSignal: AbortSignal | undefined;
    vi.mocked(env.twitch.refreshCampaigns).mockImplementation(
      async (_session, { signal } = {}) => new Promise((_resolve, reject) => {
        tickSignal = signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    );

    const ticking = env.controller.tick();
    await vi.waitFor(() => expect(tickSignal).toBeDefined());
    env.reportEvents.mockClear();

    const resetHostStorage = vi.fn();
    await env.controller.prepareForHostReset(resetHostStorage);
    await ticking;

    expect(tickSignal?.aborted).toBe(true);
    expect(resetHostStorage).toHaveBeenCalledOnce();
    const resetEvents = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(resetEvents).not.toContainEqual(expect.objectContaining({
      category: "activity",
      code: "interruption",
    }));
    expect(resetEvents).not.toContainEqual(expect.objectContaining({
      category: "diagnostic",
      level: "error",
    }));
  });

  it("restores scheduler admission when resetting host storage fails", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const resetFailure = new Error("storage reset failed");

    await expect(env.controller.prepareForHostReset(async () => {
      throw resetFailure;
    })).rejects.toBe(resetFailure);

    vi.mocked(env.kick.refreshCampaigns).mockClear();
    await env.controller.tick(["kick"], "manual_tick");

    expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce();
  });

  it("aborts in-flight scheduler work when the controller shuts down", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    let tickSignal: AbortSignal | undefined;
    vi.mocked(env.twitch.refreshCampaigns).mockImplementation(
      async (_session, { signal } = {}) => new Promise((_resolve, reject) => {
        tickSignal = signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    );

    const ticking = env.controller.tick();
    await vi.waitFor(() => expect(tickSignal).toBeDefined());

    env.controller.shutdown();
    env.controller.shutdown();
    await ticking;

    expect(tickSignal?.aborted).toBe(true);
  });

  it("allows host-reset cleanup to be retried", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.tick();

    await env.controller.prepareForHostReset();

    await expect(env.controller.prepareForHostReset()).resolves.toBeUndefined();
  });

  it("force-closes registry-owned tabs even when no live session references them", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.managedWatchTabs = {
      twitch: {
        platform: "twitch",
        tabId: 71,
        channelUrl: "https://www.twitch.tv/stale-channel",
        ownedByExtension: true,
      },
    };

    await env.controller.prepareForHostReset();

    expect(env.deps.closeManagedTabs).toHaveBeenCalledWith([expect.objectContaining({ tabId: 71 })]);
  });

  it("holds controller mutations until host storage reset finishes", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    let releaseReset!: () => void;
    const resetBlocked = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const resetStarted = vi.fn();
    const resetting = env.controller.prepareForHostReset(async () => {
      resetStarted();
      await resetBlocked;
      await env.deps.saveSettings(DEFAULT_SETTINGS);
      await env.deps.saveState(DEFAULT_STATE);
    });
    await vi.waitFor(() => expect(resetStarted).toHaveBeenCalledOnce());
    vi.mocked(env.twitch.refreshCampaigns).mockClear();

    const ticking = env.controller.tick();
    await Promise.resolve();

    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    releaseReset();
    await Promise.all([resetting, ticking]);
    expect(env.settings).toEqual(DEFAULT_SETTINGS);
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
  });
});
