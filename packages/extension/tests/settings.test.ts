import { describe, expect, it } from "vitest";
import { applySettingsPatch, DEFAULT_ENGINE_SETTINGS, DEFAULT_SETTINGS, mergeEngineSettings, mergeSettings } from "@lurkloot/shared/settings";

describe("engine settings", () => {
  // The tab-policy fields (mute / keep-unmuted / auto-close / ad focus) and the
  // pure-UI fields are host-only: the engine reads none of them, so they must not
  // appear on the EngineSettings contract.
  const HOST_ONLY_FIELDS = [
    "muteFarmingTabs",
    "keepFarmingVideosUnmuted",
    "autoCloseFinishedDrops",
    "adFocusMode",
    "languageOverride",
    "campaignVisibility",
    "rateNudgeStatus",
    "diagnosticLogging",
  ] as const;

  it("normalizes the engine contract without the host-only fields", () => {
    const engine = mergeEngineSettings({ pollIntervalMinutes: 5 });
    expect(engine.pollIntervalMinutes).toBe(5);
    expect(engine.platform.twitch).toBeDefined();
    for (const field of HOST_ONLY_FIELDS) expect(field in engine).toBe(false);
  });

  it("layers host-only fields on top of the engine defaults", () => {
    // The extension defaults are the engine defaults plus the host-only fields.
    expect(DEFAULT_SETTINGS).toMatchObject(DEFAULT_ENGINE_SETTINGS);
    for (const field of HOST_ONLY_FIELDS) expect(field in DEFAULT_SETTINGS).toBe(true);
    expect(DEFAULT_SETTINGS.adFocusMode).toBe("window");
    expect(DEFAULT_SETTINGS.languageOverride).toBe("browser");
    expect(DEFAULT_SETTINGS.rateNudgeStatus).toBe("pending");
  });
});

describe("settings", () => {
  it("defaults compatibility selections to automatic detection", () => {
    expect(mergeSettings(undefined).compatibility).toEqual({
      twitch: { profile: "auto", heartbeatTransport: "auto", inventoryQueryVersion: "auto" },
      kick: { profile: "auto", claimLinkHandling: "auto" },
    });
  });

  it("preserves bundled compatibility identifiers and normalizes invalid selections", () => {
    const settings = mergeSettings({ compatibility: {
      twitch: { profile: "twitch-2026-07", heartbeatTransport: "twitch-heartbeat-gql-v1", inventoryQueryVersion: "auto" },
      kick: { profile: "kick-2026-07", claimLinkHandling: "kick-claim-v1" },
    } } as never);
    expect(settings.compatibility.twitch.profile).toBe("twitch-2026-07");
    expect(settings.compatibility.twitch.heartbeatTransport).toBe("twitch-heartbeat-gql-v1");
    expect(settings.compatibility.kick).toEqual({ profile: "kick-2026-07", claimLinkHandling: "kick-claim-v1" });

    expect(mergeSettings({ compatibility: {
      twitch: { profile: "  ", heartbeatTransport: 42, inventoryQueryVersion: " twitch-inventory-v1 " },
      kick: { profile: null, claimLinkHandling: " kick-claim-v1 " },
    } } as never).compatibility).toEqual({
      twitch: { profile: "auto", heartbeatTransport: "auto", inventoryQueryVersion: "twitch-inventory-v1" },
      kick: { profile: "auto", claimLinkHandling: "kick-claim-v1" },
    });
  });

  it("applies partial compatibility patches without erasing sibling selections", () => {
    const current = mergeSettings({ compatibility: {
      twitch: { profile: "twitch-2026-07", heartbeatTransport: "twitch-heartbeat-gql-v1", inventoryQueryVersion: "twitch-inventory-v1" },
      kick: { profile: "kick-2026-07", claimLinkHandling: "kick-claim-v1" },
    } } as never);

    const settings = applySettingsPatch(current, {
      compatibility: { twitch: { heartbeatTransport: "auto" } },
    });

    expect(settings.compatibility).toEqual({
      twitch: { profile: "twitch-2026-07", heartbeatTransport: "auto", inventoryQueryVersion: "twitch-inventory-v1" },
      kick: { profile: "kick-2026-07", claimLinkHandling: "kick-claim-v1" },
    });
  });

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
      diagnosticLogging: false,
      platform: {
        twitch: { excludedChannels: [], farmAllCategories: true, categories: [] },
        kick: { excludedChannels: [], farmAllCategories: true, categories: [] },
      },
    });
  });

  it("defaults subscription campaigns to visible while preserving persisted choices", () => {
    expect(DEFAULT_SETTINGS.campaignVisibility.subscription).toBe(true);
    expect(mergeSettings({ campaignVisibility: { subscription: false } } as never).campaignVisibility.subscription).toBe(false);
    expect(mergeSettings({ campaignVisibility: { expired: true } } as never).campaignVisibility.subscription).toBe(true);
  });

  it("clamps persisted numeric settings to browser-safe ranges", () => {
    expect(mergeSettings({ pollIntervalMinutes: 0, offlineRetryLimit: 0 }).pollIntervalMinutes).toBe(1);
    expect(mergeSettings({ pollIntervalMinutes: 0.75 }).pollIntervalMinutes).toBe(1);
    expect(mergeSettings({ pollIntervalMinutes: 90, offlineRetryLimit: 99 }).pollIntervalMinutes).toBe(60);
    expect(mergeSettings({ pollIntervalMinutes: Number.NaN, offlineRetryLimit: Number.NaN }).pollIntervalMinutes)
      .toBe(DEFAULT_SETTINGS.pollIntervalMinutes);
    expect(mergeSettings({ offlineRetryLimit: Number.NaN }).offlineRetryLimit).toBe(DEFAULT_SETTINGS.offlineRetryLimit);
  });

  it("keeps diagnostic logging independent from the removed engine log-level setting", () => {
    expect(mergeSettings(undefined).diagnosticLogging).toBe(false);
    expect(mergeSettings({ diagnosticLogging: true }).diagnosticLogging).toBe(true);
    expect(mergeSettings({ diagnosticLogging: false, enabledLogLevels: ["debug"] } as never).diagnosticLogging).toBe(false);
    expect("enabledLogLevels" in mergeSettings({ enabledLogLevels: ["debug"] } as never)).toBe(false);
  });

  it("migrates the legacy verboseLogging flag", () => {
    expect(mergeSettings({ verboseLogging: true } as never).diagnosticLogging).toBe(true);
    expect(mergeSettings({ verboseLogging: false } as never).diagnosticLogging).toBe(false);
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

  it("validates the rate nudge status", () => {
    expect(DEFAULT_SETTINGS.rateNudgeStatus).toBe("pending");
    expect(mergeSettings(undefined).rateNudgeStatus).toBe("pending");
    expect(mergeSettings({ rateNudgeStatus: "rated" }).rateNudgeStatus).toBe("rated");
    expect(mergeSettings({ rateNudgeStatus: "dismissed" }).rateNudgeStatus).toBe("dismissed");
    expect(mergeSettings({ rateNudgeStatus: "bogus" } as unknown as Parameters<typeof mergeSettings>[0]).rateNudgeStatus)
      .toBe("pending");
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
