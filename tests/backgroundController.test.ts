import { describe, expect, it, vi } from "vitest";
import { ALARM_NAME, createBackgroundController } from "../src/background/controller";
import type { ChannelCandidate, DropCampaign, DropReward, ExtensionSettings, Platform, SchedulerState } from "../src/core/models";
import type { RuntimeSnapshot } from "../src/core/messages";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { DEFAULT_STATE } from "../src/core/storage";
import type { PlatformAdapter } from "../src/platforms/adapter";

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

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "setRunning", running: false }));

    expect(env.settings.running).toBe(false);
    expect(env.twitch.stopWatchTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 10 }), { closeManagedTabs: false });
    expect(env.kick.stopWatchTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 20 }), { closeManagedTabs: false });
    expect(snapshot.state.sessions.twitch.status).toBe("paused");
    expect(snapshot.state.sessions.kick.status).toBe("paused");
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
        twitch: { enabled: false, watchQueueChannels: [] },
        kick: { enabled: false, watchQueueChannels: [] },
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

    await env.controller.handleMessage({ type: "saveSettings", settings: nextSettings });

    expect(env.settings.pollIntervalMinutes).toBe(DEFAULT_SETTINGS.pollIntervalMinutes);
    expect(env.settings.offlineRetryLimit).toBe(1);
    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
  });

  it("recreates the scheduler alarm when saving a custom tick interval", async () => {
    const env = harness();

    await env.controller.handleMessage({
      type: "saveSettings",
      settings: { ...env.settings, pollIntervalMinutes: 17 },
    });

    expect(env.settings.pollIntervalMinutes).toBe(17);
    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: 17 });
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
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
      settings: nextSettings,
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
      settings: nextSettings,
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
      settings: nextSettings,
      tickAfterSave: true,
    }));

    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
    expect(snapshot.settings.running).toBe(false);
    expect(snapshot.settings.platform.twitch.watchQueueChannels).toEqual(["fallback"]);
  });

  it("runs an immediate scheduler tick when requested from the popup", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: true });

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "tickNow" }));

    expect(env.twitch.discoverCampaigns).toHaveBeenCalledTimes(1);
    expect(env.kick.discoverCampaigns).toHaveBeenCalledTimes(1);
    expect(snapshot.state.sessions.twitch.status).toBe("watching");
    expect(snapshot.state.sessions.kick.status).toBe("watching");
    expect(snapshot.state.events[0]).toMatchObject({
      level: "info",
      message: "Scheduler tick completed",
    });
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
        kick: { enabled: false, watchQueueChannels: [] },
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
        twitch: { enabled: false, watchQueueChannels: [] },
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
});
