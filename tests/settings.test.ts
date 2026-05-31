import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/core/settings";

describe("settings", () => {
  it("defaults mockup popup settings", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      muteFarmingTabs: true,
      keepFarmingVideosUnmuted: true,
      pauseOnManualWatch: true,
      autoCloseFinishedDrops: true,
      notifyRewardEarned: true,
      notifyNoDropsLeft: true,
      autoStartDropFarming: true,
      watchQueueFallbackOnly: true,
      pollIntervalMinutes: 1,
      platform: {
        twitch: { gamePriority: [] },
        kick: { gamePriority: [] },
      },
    });
  });

  it("clamps persisted numeric settings to browser-safe ranges", () => {
    expect(mergeSettings({ pollIntervalMinutes: 0, offlineRetryLimit: 0 }).pollIntervalMinutes).toBe(0.5);
    expect(mergeSettings({ pollIntervalMinutes: 0.75 }).pollIntervalMinutes).toBe(0.75);
    expect(mergeSettings({ pollIntervalMinutes: 90, offlineRetryLimit: 99 }).pollIntervalMinutes).toBe(60);
    expect(mergeSettings({ pollIntervalMinutes: Number.NaN, offlineRetryLimit: Number.NaN }).pollIntervalMinutes)
      .toBe(DEFAULT_SETTINGS.pollIntervalMinutes);
    expect(mergeSettings({ offlineRetryLimit: Number.NaN }).offlineRetryLimit).toBe(DEFAULT_SETTINGS.offlineRetryLimit);
  });

  it("normalizes imported list, priority, mode, and boolean settings", () => {
    const settings = mergeSettings({
      running: "yes",
      keepFarmingVideosUnmuted: false,
      pauseOnManualWatch: "no",
      priorityMode: "bad",
      platform: {
        twitch: { enabled: "true", watchQueueChannels: [" Creator ", "", "creator"], gamePriority: [" Game A ", "game a"] },
        kick: { enabled: false, watchQueueChannels: ["KickOne"], gamePriority: ["Category"] },
      },
      campaignPriorities: {
        " campaign ": 2.6,
        broken: Number.NaN,
      },
      excludedCampaignIds: [" A ", "a"],
      excludedChannels: [" Channel "],
    } as unknown as Parameters<typeof mergeSettings>[0]);

    expect(settings.running).toBe(DEFAULT_SETTINGS.running);
    expect(settings.keepFarmingVideosUnmuted).toBe(false);
    expect(settings.pauseOnManualWatch).toBe(DEFAULT_SETTINGS.pauseOnManualWatch);
    expect(settings.priorityMode).toBe(DEFAULT_SETTINGS.priorityMode);
    expect(settings.platform.twitch.enabled).toBe(DEFAULT_SETTINGS.platform.twitch.enabled);
    expect(settings.platform.twitch.watchQueueChannels).toEqual(["creator"]);
    expect(settings.platform.twitch.gamePriority).toEqual(["game a"]);
    expect(settings.platform.kick.enabled).toBe(false);
    expect(settings.platform.kick.watchQueueChannels).toEqual(["kickone"]);
    expect(settings.platform.kick.gamePriority).toEqual(["category"]);
    expect(settings.campaignPriorities).toEqual({ campaign: 3 });
    expect(settings.excludedCampaignIds).toEqual(["a"]);
    expect(settings.excludedChannels).toEqual(["channel"]);
  });

  it("preserves watch queue channel priority order while removing duplicates", () => {
    const settings = mergeSettings({
      platform: {
        twitch: { enabled: true, watchQueueChannels: ["third", "first", "second", "first"] },
        kick: { enabled: true, watchQueueChannels: [] },
      },
    });

    expect(settings.platform.twitch.watchQueueChannels).toEqual(["third", "first", "second"]);
  });
});
