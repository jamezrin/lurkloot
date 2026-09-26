import { afterEach, describe, expect, it, vi } from "vitest";
import { ALARM_NAME, isRankingOnlyPatch, KICK_ALARM_NAME, TWITCH_ALARM_NAME } from "@lurkloot/core/controller";
import type { DropCampaign } from "@lurkloot/shared/models";
import type { DiagnosticEvent } from "@lurkloot/shared/events";
import { DEFAULT_SETTINGS, IDLE_WATCHLIST_LIMIT, isFarmingActive } from "@lurkloot/shared/settings";
import {
  asSnapshot,
  campaign,
  channel,
  deferred,
  drainMicrotasks,
  farming,
  harness,
  notFarming,
} from "../helpers/backgroundController";

// Settings commits and the transitions they start.

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("reordering what is farmed", () => {
    // Pins, the strategy and favourite games only reorder what discovery found,
    // so a change to them re-selects at once instead of waiting a full refresh.
    function twoCampaigns(env: ReturnType<typeof harness>) {
      const sooner = { ...campaign("twitch"), id: "sooner", name: "Sooner", endsAt: "2099-01-01T00:00:00.000Z" };
      const later = { ...campaign("twitch"), id: "later", name: "Later", endsAt: "2099-02-01T00:00:00.000Z" };
      vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([sooner, later]);
      vi.mocked(env.twitch.listCandidateChannels).mockImplementation(async (target) => [channel("twitch", {
        username: `${target.id}-creator`, url: `https://www.twitch.tv/${target.id}-creator`,
      })]);
    }

    it("switches to a newly pinned campaign without rediscovering", async () => {
      const env = harness();
      twoCampaigns(env);
      await env.controller.tick(["twitch"]);
      expect(env.state.sessions.twitch.campaignId).toBe("sooner");
      const refreshes = vi.mocked(env.twitch.refreshCampaigns).mock.calls.length;

      await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { campaignPins: ["later"] }, tickAfterSave: true, tickAfterSavePlatforms: ["twitch"] });

      expect(env.state.sessions.twitch.campaignId).toBe("later");
      expect(vi.mocked(env.twitch.refreshCampaigns).mock.calls.length).toBe(refreshes);
    });

    it("still rediscovers a new pin while only pins are farmed", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, farmPinnedOnly: true, campaignPins: ["sooner"] }));
      twoCampaigns(env);
      await env.controller.tick(["twitch"]);
      const refreshes = vi.mocked(env.twitch.refreshCampaigns).mock.calls.length;

      await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { campaignPins: ["later", "sooner"] }, tickAfterSave: true, tickAfterSavePlatforms: ["twitch"] });

      // Discovery skipped "later" while it was unpinned, so it needs its channels found.
      expect(vi.mocked(env.twitch.refreshCampaigns).mock.calls.length).toBeGreaterThan(refreshes);
      expect(env.state.sessions.twitch.campaignId).toBe("later");
    });

    it("tells a ranking-only save apart from one discovery reads", () => {
      const off = { farmPinnedOnly: false };
      expect(isRankingOnlyPatch({ campaignPins: ["a"] }, off)).toBe(true);
      expect(isRankingOnlyPatch({ priorityMode: "lowest_availability" }, off)).toBe(true);
      expect(isRankingOnlyPatch({ platform: { twitch: { favouriteCategories: [] } } }, off)).toBe(true);
      expect(isRankingOnlyPatch({ campaignPins: ["a"] }, { farmPinnedOnly: true })).toBe(false);
      expect(isRankingOnlyPatch({ farmPinnedOnly: true }, off)).toBe(false);
      expect(isRankingOnlyPatch({ platform: { twitch: { favouriteCategories: [], categories: [] } } }, off)).toBe(false);
      expect(isRankingOnlyPatch({}, off)).toBe(false);
    });
  });

  describe("Idle Watchlist changes from the page", () => {
    const listed = (env: ReturnType<typeof harness>) => env.settings.platform.twitch.idleWatchlistChannels;
    const change = (env: ReturnType<typeof harness>, action: "add" | "remove", channel: string) =>
      env.controller.handleMessage({ type: "updateIdleWatchlist", platform: "twitch", channel, action });

    // The page menu read the list when it opened; the popup saved a newer one
    // since. Applying the change to the stored list keeps both.
    it("adds to the list as stored now, not as the page last read it", async () => {
      const env = harness();
      await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { twitch: { idleWatchlistChannels: ["first", "second"] } } } });

      await change(env, "add", "Third");

      expect(listed(env)).toEqual(["first", "second", "third"]);
    });

    it("removes only that channel, and leaves a listed one where it is", async () => {
      const env = harness();
      await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { twitch: { idleWatchlistChannels: ["first", "second", "third"] } } } });

      await change(env, "add", "second");
      expect(listed(env)).toEqual(["first", "second", "third"]);
      await change(env, "remove", "SECOND");
      expect(listed(env)).toEqual(["first", "third"]);
    });

    it("does not grow a full list", async () => {
      const env = harness();
      const full = Array.from({ length: IDLE_WATCHLIST_LIMIT }, (_, index) => `channel${index}`);
      await env.controller.handleMessage({ type: "saveSettings", settingsPatch: { platform: { twitch: { idleWatchlistChannels: full } } } });

      await change(env, "add", "extra");

      expect(listed(env)).toEqual(full);
    });
  });

  it("answers an automation toggle without waiting for the scheduler tick", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    let startDiscovery = (): void => {};
    const discoveryStarted = new Promise<void>((resolve) => {
      const blocked = new Promise<void>((release) => { startDiscovery = () => release(); });
      vi.mocked(env.twitch.refreshCampaigns).mockImplementation(async () => {
        resolve();
        await blocked;
        return [];
      });
    });

    // The raw controller, so the harness does not settle the background tick for
    // us — that is exactly what this test is about.
    const snapshot = asSnapshot(await env.rawController.handleMessage({
      type: "setAutomation",
      platform: "twitch",
      enabled: true,
    }));

    // The reply landed while discovery is still blocked: a slow tick can no
    // longer hold the popup open (the 65s stall reported in the wild).
    await discoveryStarted;
    expect(env.twitch.refreshCampaigns).toHaveBeenCalled();
    expect(isFarmingActive(snapshot.settings)).toBe(true);
    // And the session already reflects the toggle rather than the pre-toggle
    // "Automation disabled" the popup used to render for the whole tick.
    expect(snapshot.state.sessions.twitch.status).toBe("starting");

    startDiscovery();
    await env.rawController.settleBackgroundWork();
  });

  it.each([
    ["twitch", true, "Twitch automation enable"],
    ["kick", false, "Kick automation disable"],
  ] as const)("logs the requested and completed %s automation transition", async (platform, enabled, transition) => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.handleMessage({
      type: "setAutomation",
      platform,
      enabled,
    });

    const diagnostics = env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .filter((event): event is DiagnosticEvent => event.category === "diagnostic");
    expect(diagnostics).toContainEqual(expect.objectContaining({
      platform,
      level: "info",
      message: `User requested ${transition}`,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      platform,
      level: "info",
      message: `${transition} completed`,
    }));
  });

  it("logs when a Twitch enable tick queues behind existing Twitch work", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const twitchDiscovery = deferred<DropCampaign[]>();
    env.twitch.refreshCampaigns = vi.fn(() => twitchDiscovery.promise);

    const alarmTick = env.rawController.tick(["twitch"], "alarm");
    await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
    const enabling = env.rawController.handleMessage({
      type: "setAutomation",
      platform: "twitch",
      enabled: true,
    });

    try {
      await vi.waitFor(() => {
        expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(
          expect.objectContaining({
            category: "diagnostic",
            platform: "twitch",
            level: "info",
            message: "Twitch automation enable queued behind an active tick",
          }),
        );
      });
    } finally {
      twitchDiscovery.resolve([]);
      await Promise.all([alarmTick, enabling]);
      await env.rawController.settleBackgroundWork();
    }
  });

  it("toggles one platform and immediately applies the scheduler when running", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.tick();

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "setPlatformEnabled",
      platform: "twitch",
      enabled: false,
    }));

    expect(snapshot.settings.platform.twitch.enabled).toBe(false);
    expect(snapshot.settings.platform.kick.enabled).toBe(true);
    // Settings are applied synchronously; the session statuses follow from the
    // background tick, so they are read from settled state.
    expect(env.state.sessions.twitch.status).toBe("paused");
    expect(env.state.sessions.kick.status).toBe("watching");
  });

  it("enables popup automation with one settings save and one initial scheduler pass", async () => {
    const env = harness(notFarming({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false, idleWatchlistChannels: [] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
      },
    }));

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "setAutomation",
      platform: "twitch",
      enabled: true,
    }));

    expect(env.deps.saveSettings).toHaveBeenCalledTimes(1);
    expect(isFarmingActive(env.settings)).toBe(true);
    expect(env.settings.platform.twitch.enabled).toBe(true);
    expect(env.settings.platform.kick.enabled).toBe(false);
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(1);
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
    // Returned ahead of the tick, so the enabled platform reads as starting.
    expect(snapshot.state.sessions.twitch.status).toBe("starting");
    expect(env.state.sessions.twitch.status).toBe("watching");
    // Untouched: the toggle ticks only the platform it changed.
    expect(env.state.sessions.kick.status).toBe("idle");
  });

  it("saves and normalizes settings without forcing a scheduler tick", async () => {
    const env = harness();
    const nextSettings = {
      ...DEFAULT_SETTINGS,
      pollIntervalMinutes: Number.NaN,
      offlineRetryLimit: 0,
      tablessFallbackFailureLimit: 99,
    };

    await env.controller.handleMessage({ type: "saveSettings", settingsPatch: nextSettings });

    expect(env.settings.pollIntervalMinutes).toBe(DEFAULT_SETTINGS.pollIntervalMinutes);
    expect(env.settings.offlineRetryLimit).toBe(1);
    expect(env.settings.tablessFallbackFailureLimit).toBe(10);
    expect(env.deps.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ tablessFallbackFailureLimit: 10 }),
    );
    expect(env.deps.createAlarm).toHaveBeenCalledWith(TWITCH_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.deps.createAlarm).toHaveBeenCalledWith(KICK_ALARM_NAME, { periodInMinutes: DEFAULT_SETTINGS.pollIntervalMinutes });
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("recreates the scheduler alarm when saving a custom tick interval", async () => {
    const env = harness();

    await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { pollIntervalMinutes: 17 },
    });

    expect(env.settings.pollIntervalMinutes).toBe(17);
    expect(env.deps.clearAlarm).toHaveBeenCalledWith(ALARM_NAME);
    expect(env.deps.createAlarm).toHaveBeenCalledWith(TWITCH_ALARM_NAME, { periodInMinutes: 17 });
    expect(env.deps.createAlarm).toHaveBeenCalledWith(KICK_ALARM_NAME, { periodInMinutes: 17 });
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
  });

  it("merges overlapping settings patches without clobbering previous saves", async () => {
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      notifyRewardEarned: true,
      notifyNoDropsLeft: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, excludedChannels: [] },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
    }));

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

  it("preserves rapid scheduling patches without overlapping reconciliation", async () => {
    const env = harness(farming({
      ...DEFAULT_SETTINGS,
      notifyRewardEarned: true,
      notifyNoDropsLeft: true,
    }));
    let activeDiscoveries = 0;
    let maxActiveDiscoveries = 0;
    let discoveryCalls = 0;
    let markFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(env.twitch.refreshCampaigns).mockImplementation(async () => {
      discoveryCalls += 1;
      activeDiscoveries += 1;
      maxActiveDiscoveries = Math.max(maxActiveDiscoveries, activeDiscoveries);
      if (discoveryCalls === 1) {
        markFirstStarted();
        await firstGate;
      }
      activeDiscoveries -= 1;
      return [];
    });

    const first = env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { notifyRewardEarned: false },
      tickAfterSave: true,
      tickAfterSavePlatforms: ["twitch"],
    });
    await firstStarted;
    const second = env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { notifyNoDropsLeft: false },
      tickAfterSave: true,
      tickAfterSavePlatforms: ["twitch"],
    });
    await drainMicrotasks();
    releaseFirst();
    await Promise.all([first, second]);

    expect(env.settings.notifyRewardEarned).toBe(false);
    expect(env.settings.notifyNoDropsLeft).toBe(false);
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(2);
    expect(maxActiveDiscoveries).toBe(1);
  });

  it("runs a scheduler tick after saving settings when requested and automation is active", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const nextSettings = {
      ...env.settings,
      platform: {
        ...env.settings.platform,
        twitch: { ...env.settings.platform.twitch, idleWatchlistChannels: ["fallback"] },
      },
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: nextSettings,
      tickAfterSave: true,
    }));

    expect(env.twitch.refreshCampaigns).toHaveBeenCalled();
    expect(snapshot.settings.platform.twitch.idleWatchlistChannels).toEqual(["fallback"]);
  });

  it("only ticks requested platforms after saving settings with targeted platforms", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const nextSettings = {
      ...env.settings,
      platform: {
        ...env.settings.platform,
        kick: { ...env.settings.platform.kick, idleWatchlistChannels: ["fallback"] },
      },
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: nextSettings,
      tickAfterSave: true,
      tickAfterSavePlatforms: ["kick"],
    }));

    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.kick.refreshCampaigns).toHaveBeenCalled();
    expect(snapshot.settings.platform.kick.idleWatchlistChannels).toEqual(["fallback"]);
  });

  it("does not start automation after saving Idle Watchlist settings while paused", async () => {
    const env = harness(notFarming(DEFAULT_SETTINGS));
    const nextSettings = {
      ...env.settings,
      platform: {
        ...env.settings.platform,
        twitch: { ...env.settings.platform.twitch, idleWatchlistChannels: ["fallback"] },
      },
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: nextSettings,
      tickAfterSave: true,
    }));

    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(isFarmingActive(snapshot.settings)).toBe(false);
    expect(snapshot.settings.platform.twitch.idleWatchlistChannels).toEqual(["fallback"]);
  });

  it("keeps active farming untouched when saving a non-scheduling setting", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      tabId: 10,
      tabManagedByExtension: true,
      offlineChecks: 0,
    };

    const snapshot = asSnapshot(await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { notifyRewardEarned: false },
    }));

    expect(env.twitch.stopWatchTab).not.toHaveBeenCalled();
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(snapshot.state.sessions.twitch.status).toBe("watching");
  });
});
