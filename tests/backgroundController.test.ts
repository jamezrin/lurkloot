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

  it("saves and normalizes settings without forcing a scheduler tick", async () => {
    const env = harness();
    const nextSettings = { ...DEFAULT_SETTINGS, running: true, pollIntervalMinutes: Number.NaN, offlineRetryLimit: 0 };

    await env.controller.handleMessage({ type: "saveSettings", settings: nextSettings });

    expect(env.settings.pollIntervalMinutes).toBe(DEFAULT_SETTINGS.pollIntervalMinutes);
    expect(env.settings.offlineRetryLimit).toBe(1);
    expect(env.deps.createAlarm).toHaveBeenCalledWith(ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.twitch.discoverCampaigns).not.toHaveBeenCalled();
  });

  it("records playback telemetry only for the managed watch tab", async () => {
    const env = harness({ ...DEFAULT_SETTINGS, running: false });
    await env.controller.handleMessage({ type: "setRunning", running: true });

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 1,
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
      mutedVideoCount: 1,
      playingVideoCount: 1,
    });

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 0,
        mutedVideoCount: 0,
        playingVideoCount: 0,
        blockedPlaybackCount: 0,
        documentHidden: true,
      },
    }, { tab: { id: 999 } });

    expect(env.state.sessions.twitch.playback?.videoCount).toBe(1);
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
