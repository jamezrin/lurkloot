import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/core/settings";

describe("settings", () => {
  it("defaults mockup popup settings", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      muteFarmingTabs: true,
      pauseOnManualWatch: true,
      autoCloseFinishedDrops: true,
      notifyRewardEarned: true,
      notifyNoDropsLeft: true,
      autoStartDropFarming: true,
      permawatchFallbackOnly: true,
      skipOfflineFallbackChannels: true,
      gamePriority: [],
    });
  });

  it("clamps persisted numeric settings to browser-safe ranges", () => {
    expect(mergeSettings({ pollIntervalMinutes: 0, offlineRetryLimit: 0 }).pollIntervalMinutes).toBe(1);
    expect(mergeSettings({ pollIntervalMinutes: 90, offlineRetryLimit: 99 }).pollIntervalMinutes).toBe(60);
    expect(mergeSettings({ pollIntervalMinutes: Number.NaN, offlineRetryLimit: Number.NaN }).pollIntervalMinutes)
      .toBe(DEFAULT_SETTINGS.pollIntervalMinutes);
    expect(mergeSettings({ offlineRetryLimit: Number.NaN }).offlineRetryLimit).toBe(DEFAULT_SETTINGS.offlineRetryLimit);
  });

  it("normalizes imported list, priority, mode, and boolean settings", () => {
    const settings = mergeSettings({
      running: "yes",
      pauseOnManualWatch: "no",
      priorityMode: "bad",
      platform: {
        twitch: { enabled: "true", fallbackStreamers: [" Creator ", "", "creator"] },
        kick: { enabled: false, fallbackStreamers: ["KickOne"] },
      },
      campaignPriorities: {
        " campaign ": 2.6,
        broken: Number.NaN,
      },
      gamePriority: [" Game A ", "game a", "Category"],
      excludedCampaignIds: [" A ", "a"],
      excludedChannels: [" Channel "],
    } as unknown as Parameters<typeof mergeSettings>[0]);

    expect(settings.running).toBe(DEFAULT_SETTINGS.running);
    expect(settings.pauseOnManualWatch).toBe(DEFAULT_SETTINGS.pauseOnManualWatch);
    expect(settings.priorityMode).toBe(DEFAULT_SETTINGS.priorityMode);
    expect(settings.platform.twitch.enabled).toBe(DEFAULT_SETTINGS.platform.twitch.enabled);
    expect(settings.platform.twitch.fallbackStreamers).toEqual(["creator"]);
    expect(settings.platform.kick.enabled).toBe(false);
    expect(settings.platform.kick.fallbackStreamers).toEqual(["kickone"]);
    expect(settings.campaignPriorities).toEqual({ campaign: 3 });
    expect(settings.gamePriority).toEqual(["game a", "category"]);
    expect(settings.excludedCampaignIds).toEqual(["a"]);
    expect(settings.excludedChannels).toEqual(["channel"]);
  });

  it("preserves fallback streamer priority order while removing duplicates", () => {
    const settings = mergeSettings({
      platform: {
        twitch: { enabled: true, fallbackStreamers: ["third", "first", "second", "first"] },
        kick: { enabled: true, fallbackStreamers: [] },
      },
    });

    expect(settings.platform.twitch.fallbackStreamers).toEqual(["third", "first", "second"]);
  });
});
