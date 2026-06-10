import { describe, expect, it, vi } from "vitest";
import { ALARM_NAME, createBackgroundController } from "../src/background/controller";
import type { ChannelCandidate, DropCampaign, DropReward, ExtensionSettings, Platform, SchedulerState } from "@stream-autopilot/shared/models";
import type { RuntimeSnapshot } from "@stream-autopilot/shared/messages";
import { DEFAULT_SETTINGS } from "@stream-autopilot/shared/settings";
import { DEFAULT_STATE } from "../src/core/storage";
import type { PlatformAdapter } from "../src/platforms/adapter";
import type { TablessWatchController } from "../src/core/tablessWatch";

const reward = (status: DropReward["status"] = "in_progress"): DropReward => ({
  id: "reward",
  name: "Reward",
  requiredMinutes: 60,
  watchedMinutes: 10,
  status,
});

const campaign = (platform: Platform, rewardStatus: DropReward["status"] = "in_progress"): DropCampaign => ({
  id: `${platform}-campaign`,
  platform,
  name: `${platform} campaign`,
  status: "active",
  rewards: [reward(rewardStatus)],
});

const channel = (platform: Platform): ChannelCandidate => ({
  platform,
  username: `${platform}-creator`,
  url: platform === "twitch" ? "https://www.twitch.tv/twitch-creator" : "https://kick.com/kick-creator",
});

function asSnapshot(value: unknown): RuntimeSnapshot {
  return value as RuntimeSnapshot;
}

function adapter(platform: Platform): PlatformAdapter {
  return {
    platform,
    discoverCampaigns: vi.fn(async () => [campaign(platform)]),
    readProgress: vi.fn(async (campaigns) => campaigns),
    listCandidateChannels: vi.fn(async () => [channel(platform)]),
    checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
    claimReward: vi.fn(async () => true),
    prepareWatchTab: vi.fn(async () => ({ tabId: platform === "twitch" ? 10 : 20, managedByExtension: true })),
    stopWatchTab: vi.fn(async () => undefined),
  };
}

function harness(settings: ExtensionSettings = { ...DEFAULT_SETTINGS, running: true }) {
  let currentSettings = settings;
  let currentState: SchedulerState = {
    ...DEFAULT_STATE,
    sessions: {
      twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
      kick: { platform: "kick", status: "idle", offlineChecks: 0 },
    },
  };
  const twitch = adapter("twitch");
  const kick = adapter("kick");
  const deps = {
    loadSettings: vi.fn(async () => currentSettings),
    saveSettings: vi.fn(async (next: ExtensionSettings) => {
      currentSettings = next;
    }),
    loadState: vi.fn(async () => currentState),
    saveState: vi.fn(async (next: SchedulerState) => {
      currentState = next;
    }),
    createAlarm: vi.fn(async () => undefined),
    createNotification: vi.fn(async () => undefined),
    closeManagedTabsByUrl: vi.fn(async () => undefined),
    applyAdFocus: vi.fn(async () => undefined),
    createAdapters: vi.fn(() => ({ twitch, kick })),
  };

  return {
    controller: createBackgroundController(deps),
    deps,
    get settings() {
      return currentSettings;
    },
    get state() {
      return currentState;
    },
    twitch,
    kick,
  };
}

describe("background controller", () => {
  it("creates the scheduler alarm from persisted settings", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, pollIntervalMinutes: 11 });

    await env.controller.ensureAlarm();

    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: 11 });
  });

  it("auto-starts on launch only when the persisted running state is enabled", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoStartDropFarming: true });

    await env.controller.ensureAlarm();

    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
  });

  it("clears stale restart tabs and auto-resumes with fresh tabs when auto-start is enabled", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoStartDropFarming: true });
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
    env.state.managedWatchTabs = {
      twitch: {
        platform: "twitch",
        tabId: 44,
        channelUrl: "https://www.twitch.tv/twitch-creator",
        ownedByExtension: true,
      },
    };

    await env.controller.handleStartup();

    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.closeManagedTabsByUrl).toHaveBeenCalledWith(["https://www.twitch.tv/twitch-creator"]);
    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    expect(env.state.sessions.twitch.status).toBe("watching");
    expect(env.state.sessions.twitch.tabId).toBe(10);
    expect(env.state.events.some((entry) => entry.message === "Browser restart detected; cleared stale farming tabs before resuming")).toBe(true);
  });

  it("pauses stale restart sessions and disables running when auto-start is disabled", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoStartDropFarming: false });
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

    expect(env.settings.running).toBe(false);
    expect(env.deps.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ running: false }));
    expect(env.deps.closeManagedTabsByUrl).toHaveBeenCalledWith(["https://www.twitch.tv/twitch-creator"]);
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.managedWatchTabs).toEqual({});
    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      tabId: undefined,
      tabManagedByExtension: undefined,
      message: "Browser restarted; farming paused",
    });
    expect(env.state.events[0]).toMatchObject({
      level: "info",
      message: "Browser restart detected; paused farming and cleared stale farming tabs",
    });
  });

  it("cleans stale restart state without starting farming when automation is already stopped", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, autoStartDropFarming: true });
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

    expect(env.settings.running).toBe(false);
    expect(env.deps.closeManagedTabsByUrl).toHaveBeenCalledWith(["https://kick.com/kick-creator"]);
    expect(env.kick.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.sessions.kick.status).toBe("paused");
    expect(env.state.sessions.kick.tabId).toBeUndefined();
  });

  it("clears stale retained page-context tabs on startup", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, autoStartDropFarming: true });
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

    expect(env.deps.closeManagedTabsByUrl).toHaveBeenCalledWith(["https://www.twitch.tv/drops/inventory"]);
    expect(env.state.managedPageContextTabs).toEqual({});
    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      tabId: undefined,
      message: "Browser restarted; farming paused",
    });
  });

  it("does not log startup cleanup when there is no stale farming state", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, autoStartDropFarming: true });

    await env.controller.handleStartup();

    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.closeManagedTabsByUrl).not.toHaveBeenCalled();
    expect(env.deps.saveState).not.toHaveBeenCalled();
    expect(env.state.events).toEqual([]);
  });

  it("disables running on startup when auto-start is disabled even without stale tabs", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoStartDropFarming: false });

    await env.controller.handleStartup();

    expect(env.settings.running).toBe(false);
    expect(env.deps.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ running: false }));
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(env.deps.saveState).not.toHaveBeenCalled();
  });

  it("starts automation, persists settings, creates alarm, and runs an immediate tick", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "setRunning", running: true }));

    expect(env.settings.running).toBe(true);
    expect(env.deps.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ running: true }));
    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    expect(snapshot.state.sessions.twitch.status).toBe("watching");
  });

  it("stops automation immediately and applies auto-close behavior to active watch tabs", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoCloseFinishedDrops: false });
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

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "setRunning", running: false }));

    expect(env.settings.running).toBe(false);
    expect(env.twitch.stopWatchTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 10 }), { closeManagedTabs: false });
    expect(env.kick.stopWatchTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 20 }), { closeManagedTabs: false });
    expect(snapshot.state.sessions.twitch.status).toBe("paused");
    expect(snapshot.state.sessions.kick.status).toBe("paused");
    expect(snapshot.state.managedPageContextTabs?.twitch).toBeUndefined();
  });

  it("toggles one platform and immediately applies the scheduler when running", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    await env.controller.tick();

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "setPlatformEnabled",
      platform: "twitch",
      enabled: false,
    }));

    expect(snapshot.settings.platform.twitch.enabled).toBe(false);
    expect(snapshot.settings.platform.kick.enabled).toBe(true);
    expect(snapshot.state.sessions.twitch.status).toBe("paused");
    expect(snapshot.state.sessions.kick.status).toBe("watching");
  });

  it("enables popup automation with one settings save and one initial scheduler pass", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: false,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false, watchQueueChannels: [] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, watchQueueChannels: [] },
      },
    });

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "setAutomation",
      platform: "twitch",
      enabled: true,
    }));

    expect(env.deps.saveSettings).toHaveBeenCalledTimes(1);
    expect(env.settings.running).toBe(true);
    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.settings.platform.kick.enabled).toBe(false);
    expect(env.twitch.discoverCampaigns).toHaveBeenCalledTimes(1);
    expect(env.kick.discoverCampaigns).not.toHaveBeenCalled();
    expect(snapshot.state.sessions.twitch.status).toBe("watching");
    expect(snapshot.state.sessions.kick.status).toBe("paused");
  });

  it("saves and normalizes settings without forcing a scheduler tick", async () => {
    const env = harness();
    const nextSettings = { ...DEFAULT_SETTINGS, running: true, pollIntervalMinutes: Number.NaN, offlineRetryLimit: 0 };

    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: nextSettings });

    expect(env.settings.pollIntervalMinutes).toBe(DEFAULT_SETTINGS.pollIntervalMinutes);
    expect(env.settings.offlineRetryLimit).toBe(1);
    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
  });

  it("recreates the scheduler alarm when saving a custom tick interval", async () => {
    const env = harness();

    await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { pollIntervalMinutes: 17 },
    });

    expect(env.settings.pollIntervalMinutes).toBe(17);
    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: 17 });
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
  });

  it("merges overlapping settings patches without clobbering previous saves", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      notifyRewardEarned: true,
      notifyNoDropsLeft: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, excludedChannels: [] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
    });

    await Promise.all([
      env.controller.handleMessage({
        type: "saveSettings",
        settingsPatch: {
          notifyRewardEarned: false,
          platform: { twitch: { excludedChannels: ["skipme"] } },
        },
      }),
      env.controller.handleMessage({
        type: "saveSettings",
        settingsPatch: {
          notifyNoDropsLeft: false,
          platform: { kick: { enabled: false } },
        },
      }),
    ]);

    expect(env.settings.notifyRewardEarned).toBe(false);
    expect(env.settings.notifyNoDropsLeft).toBe(false);
    expect(env.settings.platform.twitch.excludedChannels).toEqual(["skipme"]);
    expect(env.settings.platform.kick.enabled).toBe(false);
  });

  it("runs a scheduler tick after saving settings when requested and automation is active", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    const nextSettings = {
      ...env.settings,
      platform: {
        ...env.settings.platform,
        twitch: { ...env.settings.platform.twitch, watchQueueChannels: ["fallback"] },
      },
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: nextSettings,
      tickAfterSave: true,
    }));

    expect(env.twitch.discoverCampaigns).toHaveBeenCalled();
    expect(snapshot.settings.platform.twitch.watchQueueChannels).toEqual(["fallback"]);
  });

  it("only ticks requested platforms after saving settings with targeted platforms", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    const nextSettings = {
      ...env.settings,
      platform: {
        ...env.settings.platform,
        kick: { ...env.settings.platform.kick, watchQueueChannels: ["fallback"] },
      },
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: nextSettings,
      tickAfterSave: true,
      tickAfterSavePlatforms: ["kick"],
    }));

    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.kick.discoverCampaigns).toHaveBeenCalled();
    expect(snapshot.settings.platform.kick.watchQueueChannels).toEqual(["fallback"]);
  });

  it("does not start automation after saving Watch Queue settings while paused", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    const nextSettings = {
      ...env.settings,
      platform: {
        ...env.settings.platform,
        twitch: { ...env.settings.platform.twitch, watchQueueChannels: ["fallback"] },
      },
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: nextSettings,
      tickAfterSave: true,
    }));

    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(snapshot.settings.running).toBe(false);
    expect(snapshot.settings.platform.twitch.watchQueueChannels).toEqual(["fallback"]);
  });

  it("temporarily pauses active sessions while a settings session is open without persisting running=false", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      tabId: 10,
      tabManagedByExtension: true,
      offlineChecks: 0,
    };

    await env.controller.beginSettingsSession();

    expect(env.settings.running).toBe(true);
    expect(env.twitch.stopWatchTab).toHaveBeenCalledWith(expect.objectContaining({ status: "watching" }), expect.anything());
    expect(env.state.sessions.twitch.status).toBe("paused");
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();

    await env.controller.endSettingsSession();

    expect(env.settings.running).toBe(true);
    expect(env.twitch.discoverCampaigns).toHaveBeenCalled();
  });

  it("does not run tickAfterSave automation while settings are temporarily paused", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });

    await env.controller.beginSettingsSession();
    vi.mocked(env.twitch.discoverCampaigns).mockClear();
    vi.mocked(env.kick.discoverCampaigns).mockClear();

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { priorityMode: "priority_list_only" },
      tickAfterSave: true,
    }));

    expect(snapshot.settings.running).toBe(true);
    expect(snapshot.settings.priorityMode).toBe("priority_list_only");
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(env.kick.discoverCampaigns).not.toHaveBeenCalled();
  });

  it("runs an immediate scheduler tick when requested from the popup", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "tickNow" }));

    expect(env.twitch.discoverCampaigns).toHaveBeenCalledTimes(1);
    expect(env.kick.discoverCampaigns).toHaveBeenCalledTimes(1);
    expect(snapshot.state.sessions.twitch.status).toBe("watching");
    expect(snapshot.state.sessions.kick.status).toBe("watching");
    // The tick ran and recorded the per-platform decision; the debug-only
    // "Scheduler tick completed" heartbeat is suppressed while verbose is off.
    expect(snapshot.state.events.some((event) => event.message === "Eligible campaign selected")).toBe(true);
    expect(snapshot.state.events.some((event) => event.level === "debug")).toBe(false);
  });

  it("records debug entries only when the debug level is enabled", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, enabledLogLevels: ["debug", "info", "warn", "error"] });

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "tickNow" }));

    expect(snapshot.state.events[0]).toMatchObject({
      level: "debug",
      message: "Scheduler tick completed",
    });
    expect(snapshot.state.events.some((event) => event.level === "debug" && event.message.startsWith("Tick start"))).toBe(true);
  });

  it("records playback telemetry only for the managed watch tab", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    await env.controller.handleMessage({ type: "setRunning", running: true });

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
        readyState: 4,
        currentTime: 12,
        duration: 1200,
      },
    }, { tab: { id: 10 } });

    expect(env.state.sessions.twitch.playback).toMatchObject({
      platform: "twitch",
      videoCount: 1,
      mutedVideoCount: 0,
      unmutedVideoCount: 1,
      playingVideoCount: 1,
    });

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 0,
        mutedVideoCount: 0,
        unmutedVideoCount: 0,
        playingVideoCount: 0,
        blockedPlaybackCount: 0,
        documentHidden: true,
      },
    }, { tab: { id: 999 } });

    expect(env.state.sessions.twitch.playback?.videoCount).toBe(1);
  });

  it("records visible playback in a non-managed tab as manual watch activity", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, pauseOnManualWatch: true });
    await env.controller.handleMessage({ type: "setRunning", running: true });

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    }, { tab: { id: 999 } });

    expect(env.state.manualWatch?.twitch).toMatchObject({
      platform: "twitch",
      tabId: 999,
      active: true,
    });
    expect(env.state.sessions.twitch.playback).toBeUndefined();
  });

  it("clears manual watch activity when the source tab is closed", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, pauseOnManualWatch: true });
    env.state.manualWatch = {
      twitch: {
        platform: "twitch",
        tabId: 999,
        active: true,
        checkedAt: new Date().toISOString(),
      },
    };

    await env.controller.handleTabRemoved(999);

    expect(env.state.manualWatch?.twitch).toBeUndefined();
  });

  it("marks manual watch inactive when the same tab stops visible playback", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, pauseOnManualWatch: true });
    env.state.manualWatch = {
      twitch: {
        platform: "twitch",
        tabId: 999,
        active: true,
        checkedAt: new Date().toISOString(),
      },
    };

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 0,
        blockedPlaybackCount: 0,
        documentHidden: false,
      },
    }, { tab: { id: 999 } });

    expect(env.state.manualWatch?.twitch).toMatchObject({
      tabId: 999,
      active: false,
    });
  });

  it("logs playback transitions such as ad starts and blocked playback", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    await env.controller.handleMessage({ type: "setRunning", running: true });

    // Baseline healthy telemetry — no ad, nothing blocked.
    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: { videoCount: 1, mutedVideoCount: 0, unmutedVideoCount: 1, playingVideoCount: 1, blockedPlaybackCount: 0, documentHidden: false, adActive: false },
    }, { tab: { id: 10 } });

    // Ad starts and the browser blocks playback (re-muted).
    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: { videoCount: 1, mutedVideoCount: 1, unmutedVideoCount: 0, playingVideoCount: 1, blockedPlaybackCount: 1, documentHidden: false, adActive: true },
    }, { tab: { id: 10 } });

    const messages = env.state.events.map((event) => event.message);
    expect(messages).toContain("Ad started; keeping the watch tab counting down");
    expect(env.state.events.some((event) => event.level === "warn" && event.message.startsWith("Playback was blocked"))).toBe(true);
  });

  it("focuses the watch tab when an ad is reported on the managed tab", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, adFocusMode: "window" });
    await env.controller.handleMessage({ type: "setRunning", running: true });
    env.deps.applyAdFocus.mockClear();

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
        adActive: true,
      },
    }, { tab: { id: 10 } });

    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("twitch", 10, true, "window");
  });

  it("releases ad focus when telemetry reports no ad", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, adFocusMode: "tab" });
    await env.controller.handleMessage({ type: "setRunning", running: true });
    env.deps.applyAdFocus.mockClear();

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
        adActive: false,
      },
    }, { tab: { id: 10 } });

    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("twitch", 10, false, "tab");
  });

  it("does not focus for telemetry from a tab that is not the watch tab", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    await env.controller.handleMessage({ type: "setRunning", running: true });
    env.deps.applyAdFocus.mockClear();

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
        adActive: true,
      },
    }, { tab: { id: 999 } });

    expect(env.deps.applyAdFocus).not.toHaveBeenCalled();
  });

  it("ignores playback telemetry without a sender tab", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    await env.controller.handleMessage({ type: "setRunning", running: true });
    env.deps.applyAdFocus.mockClear();

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
        adActive: true,
      },
    });

    expect(env.state.sessions.twitch.playback).toBeUndefined();
    expect(env.state.manualWatch?.twitch).toBeUndefined();
    expect(env.deps.applyAdFocus).not.toHaveBeenCalled();
    expect(env.state.events.some((event) => event.message.startsWith("Ad started"))).toBe(false);
  });

  it("does not treat tabless sessions as managed playback telemetry targets", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      watchMode: "tabless",
    };

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 0,
        unmutedVideoCount: 1,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: false,
        adActive: true,
      },
    }, { tab: { id: 10 } });

    expect(env.state.sessions.twitch.playback).toBeUndefined();
    expect(env.state.manualWatch?.twitch).toMatchObject({
      tabId: 10,
      active: true,
    });
    expect(env.deps.applyAdFocus).not.toHaveBeenCalled();
  });

  it("re-applies ad focus from playback state on each scheduler tick", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });

    await env.controller.handleMessage({ type: "tickNow" });

    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("twitch", 10, false, "window");
    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("kick", 20, false, "window");
  });

  it("allows playback control only for the current watch tab", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    await env.controller.handleMessage({ type: "setRunning", running: true });

    await expect(env.controller.handleMessage(
      { type: "getPlaybackControl", platform: "twitch" },
      { tab: { id: 10 } },
    )).resolves.toEqual({ managed: true, keepVideosUnmuted: true });

    await expect(env.controller.handleMessage(
      { type: "getPlaybackControl", platform: "twitch" },
      { tab: { id: 999 } },
    )).resolves.toEqual({ managed: false, keepVideosUnmuted: true });
  });

  it("passes the playback control setting to managed watch tabs", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false, keepFarmingVideosUnmuted: false });
    await env.controller.handleMessage({ type: "setRunning", running: true });

    await expect(env.controller.handleMessage(
      { type: "getPlaybackControl", platform: "twitch" },
      { tab: { id: 10 } },
    )).resolves.toEqual({ managed: true, keepVideosUnmuted: false });
  });

  it("defaults playback control on when stored settings are missing the advanced flag", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    env.deps.loadSettings.mockResolvedValueOnce({
      ...DEFAULT_SETTINGS,
      running: true,
      keepFarmingVideosUnmuted: undefined,
    } as unknown as typeof DEFAULT_SETTINGS);
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
    };

    await expect(env.controller.handleMessage(
      { type: "getPlaybackControl", platform: "twitch" },
      { tab: { id: 10 } },
    )).resolves.toEqual({ managed: true, keepVideosUnmuted: true });
  });

  it("runs an immediate tick when the active managed Twitch tab is closed", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, watchQueueChannels: [] },
      },
    });
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
    };

    await env.controller.handleTabRemoved(10);

    expect(env.twitch.discoverCampaigns).toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
  });

  it("ignores removed tabs that are not the active managed watch tab", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
    };

    await env.controller.handleTabRemoved(999);

    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
  });

  it("does not reopen a closed tab for a disabled platform", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false, watchQueueChannels: [] },
      },
    });
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
    };

    await env.controller.handleTabRemoved(10);

    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
  });

  it("tracks one managed watch tab per running platform", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });

    await env.controller.tick();

    expect(env.state.sessions.twitch.tabId).toBe(10);
    expect(env.state.sessions.kick.tabId).toBe(20);
    expect(env.state.managedWatchTabs).toMatchObject({
      twitch: {
        platform: "twitch",
        tabId: 10,
        channelUrl: "https://www.twitch.tv/twitch-creator",
        ownedByExtension: true,
      },
      kick: {
        platform: "kick",
        tabId: 20,
        channelUrl: "https://kick.com/kick-creator",
        ownedByExtension: true,
      },
    });
  });

  it("manually claims a claimable reward through the platform adapter", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, autoClaim: false });
    const twitchCampaign = campaign("twitch", "claimable");
    vi.mocked(env.twitch.discoverCampaigns).mockResolvedValue([twitchCampaign]);

    await env.controller.tick();
    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: "reward",
    }));

    expect(env.twitch.claimReward).toHaveBeenCalledWith(
      expect.objectContaining({ id: "twitch-campaign" }),
      expect.objectContaining({ id: "reward", status: "claimable" }),
    );
    expect(snapshot.state.campaigns.twitch[0]).toMatchObject({
      status: "completed",
      rewards: [{ id: "reward", status: "claimed", watchedMinutes: 60 }],
    });
  });

  it("records a warning when a manual claim target is stale", async () => {
    const env = harness();

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "missing-campaign",
      rewardId: "reward",
    }));

    expect(env.twitch.claimReward).not.toHaveBeenCalled();
    expect(snapshot.state.events[0]).toMatchObject({
      platform: "twitch",
      level: "warn",
      message: "Reward claim skipped because the campaign or reward is no longer available",
    });
  });

  it("emits reward notifications best-effort when rewards become earned", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, notifyRewardEarned: true });
    env.state.campaigns.twitch = [campaign("twitch", "in_progress")];
    vi.mocked(env.twitch.discoverCampaigns).mockResolvedValue([campaign("twitch", "claimable")]);

    await env.controller.tick();

    expect(env.deps.createNotification).toHaveBeenCalledWith({
      title: "Reward earned",
      message: "Reward from twitch campaign",
    });
  });

  it("does not emit disabled reward notifications", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true, notifyRewardEarned: false });
    env.state.campaigns.twitch = [campaign("twitch", "in_progress")];
    vi.mocked(env.twitch.discoverCampaigns).mockResolvedValue([campaign("twitch", "claimable")]);

    await env.controller.tick();

    expect(env.deps.createNotification).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Reward earned" }));
  });

  it("persists an error event when scheduler execution throws unexpectedly", async () => {
    const env = harness();
    vi.mocked(env.deps.createAdapters).mockImplementation(() => {
      throw new Error("adapter factory failed");
    });

    await env.controller.tick();

    expect(env.state.events[0].level).toBe("error");
    expect(env.state.events[0].message).toBe("adapter factory failed");
  });

  function fakeTablessWatcher(tick: () => Promise<{ ok: boolean; live?: boolean; message?: string }>) {
    const watcher = {
      platform: "twitch" as const,
      channelUrl: undefined as string | undefined,
      start: vi.fn(async (ch: { url: string }) => {
        watcher.channelUrl = ch.url;
      }),
      tick: vi.fn(tick),
      stop: vi.fn(async () => {
        watcher.channelUrl = undefined;
      }),
    };
    return watcher;
  }

  function tablessEnv(overrides: Partial<ExtensionSettings> = {}) {
    const env = harness({
      ...DEFAULT_SETTINGS,
      running: true,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, watchQueueChannels: [] },
      },
      ...overrides,
    });
    env.twitch.supportsTabless = true;
    return env;
  }

  it("farms tablessly without opening a tab and records heartbeat health", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;

    await env.controller.tick();

    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.sessions.twitch.watchMode).toBe("tabless");
    expect(watcher.start).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://www.twitch.tv/twitch-creator" }),
      expect.any(Object),
    );

    await env.controller.runWatchHeartbeat();

    expect(watcher.tick).toHaveBeenCalled();
    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    expect(env.state.sessions.twitch.heartbeatChecks).toBe(0);
  });

  it("falls back to a watch tab once the tabless heartbeat keeps failing", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: false, live: true }));
    const env = tablessEnv({ offlineRetryLimit: 2 });
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;

    await env.controller.tick();
    expect(env.state.sessions.twitch.watchMode).toBe("tabless");

    await env.controller.runWatchHeartbeat(); // heartbeatChecks -> 1
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();

    await env.controller.runWatchHeartbeat(); // heartbeatChecks -> 2, triggers fallback

    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    expect(env.state.sessions.twitch.watchMode).toBe("tab");
    expect(env.state.sessions.twitch.tablessFallback).toBe(true);
    expect(watcher.stop).toHaveBeenCalled();
  });

  it("rebuilds tabless watchers from persisted sessions after a service-worker restart", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    // Simulate a fresh service worker: a tabless watch session is persisted, but
    // no tick() has run this lifetime to populate the in-memory watcher map.
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
    };

    await env.controller.runWatchHeartbeat();

    expect(watcher.start).toHaveBeenCalled();
    expect(watcher.tick).toHaveBeenCalled();
    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    expect(env.state.sessions.twitch.heartbeatChecks).toBe(0);
  });

  it("serializes concurrent state writers so neither update is lost", async () => {
    const env = harness();
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
    };

    // Model storage snapshot semantics: each load returns an isolated copy, so
    // an unserialized handler building on a stale snapshot would clobber a newer
    // save. Trace load/save ordering to prove the lock serializes them.
    const trace: string[] = [];
    const originalSave = env.deps.saveState.getMockImplementation()!;
    env.deps.loadState.mockImplementation(async () => {
      trace.push("load");
      return structuredClone(env.state);
    });
    env.deps.saveState.mockImplementation(async (next: SchedulerState) => {
      trace.push("save");
      await Promise.resolve();
      await originalSave(next);
    });

    await Promise.all([
      env.controller.handleMessage(
        {
          type: "playbackTelemetry",
          platform: "twitch",
          telemetry: {
            videoCount: 1,
            mutedVideoCount: 0,
            unmutedVideoCount: 1,
            playingVideoCount: 1,
            blockedPlaybackCount: 0,
            documentHidden: false,
          },
        },
        { tab: { id: 10 } },
      ),
      env.controller.tick(),
    ]);

    // Serialized: every load is immediately followed by that operation's save
    // before the next operation's load (never load, load, save, save).
    expect(trace.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i + 1 < trace.length; i += 2) {
      expect(trace[i]).toBe("load");
      expect(trace[i + 1]).toBe("save");
    }
    // Both writers' changes survive in the final persisted state.
    expect(env.state.sessions.twitch.playback).toBeDefined();
    expect(env.state.lastTickAt).toBeDefined();
  });

  it("serializes handleTabRemoved against a concurrent tick so neither write is lost", async () => {
    const env = harness();
    env.state.manualWatch = {
      kick: { platform: "kick", tabId: 50, checkedAt: new Date().toISOString(), active: true },
    };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
    };

    // Same snapshot-isolation trace as the writer-serialization test above: an
    // unserialized handleTabRemoved would build on a stale snapshot and clobber
    // tick()'s save (or vice versa).
    const trace: string[] = [];
    const originalSave = env.deps.saveState.getMockImplementation()!;
    env.deps.loadState.mockImplementation(async () => {
      trace.push("load");
      return structuredClone(env.state);
    });
    env.deps.saveState.mockImplementation(async (next: SchedulerState) => {
      trace.push("save");
      await Promise.resolve();
      await originalSave(next);
    });

    await Promise.all([
      env.controller.handleTabRemoved(50),
      env.controller.tick(),
    ]);

    // Serialized: every load is immediately followed by that operation's save.
    expect(trace.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i + 1 < trace.length; i += 2) {
      expect(trace[i]).toBe("load");
      expect(trace[i + 1]).toBe("save");
    }
    // Both writers' changes survive: the manual-watch entry is removed AND the
    // concurrent tick committed its progress.
    expect(env.state.manualWatch?.kick).toBeUndefined();
    expect(env.state.lastTickAt).toBeDefined();
  });
});
