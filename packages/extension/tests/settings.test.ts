import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "@lurkloot/shared/settings";

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
      languageOverride: "browser",
      watchQueueFallbackOnly: true,
      pollIntervalMinutes: 1,
      enabledLogLevels: ["info", "warn", "error"],
      platform: {
        twitch: { excludedChannels: [], farmAllCategories: true, categories: [] },
        kick: { excludedChannels: [], farmAllCategories: true, categories: [] },
      },
    });
  });

  it("clamps persisted numeric settings to browser-safe ranges", () => {
    expect(mergeSettings({ pollIntervalMinutes: 0, offlineRetryLimit: 0 }).pollIntervalMinutes).toBe(1);
    expect(mergeSettings({ pollIntervalMinutes: 0.75 }).pollIntervalMinutes).toBe(1);
    expect(mergeSettings({ pollIntervalMinutes: 90, offlineRetryLimit: 99 }).pollIntervalMinutes).toBe(60);
    expect(mergeSettings({ pollIntervalMinutes: Number.NaN, offlineRetryLimit: Number.NaN }).pollIntervalMinutes)
      .toBe(DEFAULT_SETTINGS.pollIntervalMinutes);
    expect(mergeSettings({ offlineRetryLimit: Number.NaN }).offlineRetryLimit).toBe(DEFAULT_SETTINGS.offlineRetryLimit);
  });

  it("normalizes enabled log levels and always keeps error", () => {
    // Defaults when nothing is stored.
    expect(mergeSettings(undefined).enabledLogLevels).toEqual(["info", "warn", "error"]);
    expect(mergeSettings({ enabledLogLevels: undefined }).enabledLogLevels).toEqual(["info", "warn", "error"]);
    // Invalid/duplicate/out-of-order entries are filtered to canonical order.
    expect(mergeSettings({ enabledLogLevels: ["warn", "debug", "warn", "bogus"] as never }).enabledLogLevels)
      .toEqual(["debug", "warn", "error"]);
    // Error is forced on even if omitted.
    expect(mergeSettings({ enabledLogLevels: ["info"] }).enabledLogLevels).toEqual(["info", "error"]);
    // An explicit empty array still records errors.
    expect(mergeSettings({ enabledLogLevels: [] }).enabledLogLevels).toEqual(["error"]);
  });

  it("migrates the legacy verboseLogging flag", () => {
    expect(mergeSettings({ verboseLogging: true } as never).enabledLogLevels).toEqual(["debug", "info", "warn", "error"]);
    expect(mergeSettings({ verboseLogging: false } as never).enabledLogLevels).toEqual(["info", "warn", "error"]);
  });

  it("normalizes imported list, priority, mode, and boolean settings", () => {
    const settings = mergeSettings({
      running: "yes",
      keepFarmingVideosUnmuted: false,
      pauseOnManualWatch: "no",
      priorityMode: "bad",
      platform: {
        twitch: {
          enabled: "true",
          watchQueueChannels: [" Creator ", "", "creator"],
          excludedChannels: [" @SkipMe ", "skipme"],
          categories: [{ id: " Game-A ", name: " Game A " }, { id: "game-a", name: "Dup" }, { id: "", name: "blank" }],
        },
        kick: { enabled: false, watchQueueChannels: ["KickOne"], excludedChannels: ["KickSkip"], categories: [{ id: "cat-1", name: "Category" }] },
      },
      campaignPriorities: {
        " campaign ": 2.6,
        broken: Number.NaN,
      },
      excludedCampaignIds: [" Abc ", "abc", "Abc"],
    } as unknown as Parameters<typeof mergeSettings>[0]);

    expect(settings.running).toBe(DEFAULT_SETTINGS.running);
    expect(settings.keepFarmingVideosUnmuted).toBe(false);
    expect(settings.pauseOnManualWatch).toBe(DEFAULT_SETTINGS.pauseOnManualWatch);
    expect(settings.priorityMode).toBe(DEFAULT_SETTINGS.priorityMode);
    expect(settings.platform.twitch.enabled).toBe(DEFAULT_SETTINGS.platform.twitch.enabled);
    expect(settings.platform.twitch.watchQueueChannels).toEqual(["creator"]);
    expect(settings.platform.twitch.excludedChannels).toEqual(["skipme"]);
    // Categories: trimmed, deduped by lowercased id (order preserved), blanks dropped.
    expect(settings.platform.twitch.categories).toEqual([{ id: "Game-A", name: "Game A" }]);
    expect(settings.platform.kick.enabled).toBe(false);
    expect(settings.platform.kick.watchQueueChannels).toEqual(["kickone"]);
    expect(settings.platform.kick.excludedChannels).toEqual(["kickskip"]);
    expect(settings.platform.kick.categories).toEqual([{ id: "cat-1", name: "Category" }]);
    expect(settings.campaignPriorities).toEqual({ campaign: 3 });
    // Campaign ids are trimmed and deduped but kept case-sensitive so they match
    // campaign.id verbatim in the scheduler (unlike channel/game lists).
    expect(settings.excludedCampaignIds).toEqual(["Abc", "abc"]);
  });

  it("validates the ad focus mode", () => {
    expect(DEFAULT_SETTINGS.adFocusMode).toBe("window");
    expect(mergeSettings(undefined).adFocusMode).toBe("window");
    expect(mergeSettings({ adFocusMode: "tab" }).adFocusMode).toBe("tab");
    expect(mergeSettings({ adFocusMode: "none" }).adFocusMode).toBe("none");
    expect(mergeSettings({ adFocusMode: "sideways" } as unknown as Parameters<typeof mergeSettings>[0]).adFocusMode)
      .toBe("window");
  });

  it("validates the priority mode", () => {
    expect(DEFAULT_SETTINGS.priorityMode).toBe("ending_soonest");
    expect(mergeSettings(undefined).priorityMode).toBe("ending_soonest");
    expect(mergeSettings({ priorityMode: "lowest_availability" }).priorityMode).toBe("lowest_availability");
    expect(mergeSettings({ priorityMode: "priority_list_only" }).priorityMode).toBe("priority_list_only");
    expect(mergeSettings({ priorityMode: "nonsense" } as unknown as Parameters<typeof mergeSettings>[0]).priorityMode)
      .toBe("ending_soonest");
  });

  it("validates the language override", () => {
    expect(mergeSettings(undefined).languageOverride).toBe("browser");
    expect(mergeSettings({ languageOverride: "es" }).languageOverride).toBe("es");
    expect(mergeSettings({ languageOverride: "zh_CN" }).languageOverride).toBe("zh_CN");
    expect(mergeSettings({ languageOverride: "pt_BR" }).languageOverride).toBe("pt_BR");
    expect(mergeSettings({ languageOverride: "ar" }).languageOverride).toBe("ar");
    expect(mergeSettings({ languageOverride: "pt" } as unknown as Parameters<typeof mergeSettings>[0]).languageOverride)
      .toBe("browser");
  });

  it("preserves watch queue channel priority order while removing duplicates", () => {
    const settings = mergeSettings({
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, watchQueueChannels: ["third", "first", "second", "first"] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, watchQueueChannels: [] },
      },
    });

    expect(settings.platform.twitch.watchQueueChannels).toEqual(["third", "first", "second"]);
  });

  it("defaults Farm all categories on and ignores the legacy gamePriority list", () => {
    const settings = mergeSettings({
      platform: {
        twitch: { enabled: true, watchQueueChannels: [], gamePriority: ["13", "rust"] },
        kick: { enabled: true, watchQueueChannels: [] },
      },
    } as unknown as Parameters<typeof mergeSettings>[0]);

    expect(settings.platform.twitch.farmAllCategories).toBe(true);
    expect(settings.platform.kick.farmAllCategories).toBe(true);
    // The legacy ordering list is dropped (it had no display names), so no bare
    // ids like "13" leak in as categories.
    expect(settings.platform.twitch.categories).toEqual([]);
    expect(settings.platform.kick.categories).toEqual([]);
  });
});
