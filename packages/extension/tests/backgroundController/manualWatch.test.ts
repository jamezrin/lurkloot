import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundController } from "@lurkloot/core/controller";
import type { DropCampaign, Platform } from "@lurkloot/shared/models";
import type { EngineEvent } from "@lurkloot/shared/events";
import { DEFAULT_SETTINGS, isFarmingActive } from "@lurkloot/shared/settings";
import {
  allDiagnostics,
  asSnapshot,
  campaign,
  channel,
  deferred,
  farming,
  harness,
} from "../helpers/backgroundController";
import { hostPortsFromMocks } from "../helpers/hostPorts";

// Manual watch, managed-tab events and playback telemetry.

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records playback telemetry only for the managed watch tab", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });

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

  it("clears accumulated playback checks as soon as the watch tab reports playback (#250)", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });
    env.state.sessions.twitch = { ...env.state.sessions.twitch, playbackChecks: 2 };

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
    }, { tab: { id: 10 } });

    expect(env.state.sessions.twitch.playbackChecks).toBe(2);

    await env.controller.handleMessage({
      type: "playbackTelemetry",
      platform: "twitch",
      telemetry: {
        videoCount: 1,
        mutedVideoCount: 1,
        unmutedVideoCount: 0,
        playingVideoCount: 1,
        blockedPlaybackCount: 0,
        documentHidden: true,
      },
    }, { tab: { id: 10 } });

    expect(env.state.sessions.twitch.playbackChecks).toBe(0);
  });

  describe("manual-watch event transitions", () => {
    const telemetry = { videoCount: 1, mutedVideoCount: 0, unmutedVideoCount: 1,
      playingVideoCount: 1, blockedPlaybackCount: 0, documentHidden: false };
    async function report(env: ReturnType<typeof harness>, platform: Platform, id: number, url: string,
      patch: Partial<typeof telemetry> = {}) {
      await env.controller.handleMessage({ type: "playbackTelemetry", platform,
        telemetry: { ...telemetry, ...patch } }, { tab: { id, url } });
      await env.controller.settleBackgroundWork();
    }

    it.each(["twitch", "kick"] as const)("resumes %s immediately after playback stops or becomes hidden", async (platform) => {
      for (const patch of [{ playingVideoCount: 0 }, { documentHidden: true }]) {
        const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
        const url = platform === "twitch" ? "https://www.twitch.tv/creator" : "https://kick.com/creator";
        await report(env, platform, 999, url);
        expect(env.state.sessions[platform].reasonCode).toBe("manual_watch");
        await report(env, platform, 999, url, patch);
        expect(env.state.sessions[platform].status).toBe("watching");
      }
    });

    it.each(["twitch", "kick"] as const)("ignores non-stream %s pages even with visible video", async (platform) => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
      await env.controller.tick();
      const host = platform === "twitch" ? "https://www.twitch.tv" : "https://kick.com";
      for (const route of ["settings", "settings/profile", "inventory", "drops/inventory", "directory", ...(platform === "kick" ? ["categories"] : []), "videos/123", "creator/clips", "creator/videos/123"]) {
        await report(env, platform, 999, `${host}/${route}`);
        expect(env.state.manualWatch?.[platform]?.active).not.toBe(true);
        expect(env.state.sessions[platform].status).toBe("watching");
      }
    });

    it.each(["twitch", "kick"] as const)("keeps %s paused until the last manual tab closes", async (platform) => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
      const host = platform === "twitch" ? "https://www.twitch.tv" : "https://kick.com";
      await report(env, platform, 999, `${host}/firstcreator`);
      await report(env, platform, 1000, `${host}/secondcreator`);
      await env.controller.handleTabRemoved(1000);
      await env.controller.settleBackgroundWork();
      expect(env.state.sessions[platform].reasonCode).toBe("manual_watch");
      expect(env.state.manualWatch?.[platform]?.tabId).toBe(999);
      await env.controller.handleTabRemoved(999);
      await env.controller.settleBackgroundWork();
      expect(env.state.sessions[platform].status).toBe("watching");
    });

    it("keeps another stream active when an unrelated tab reports inactive playback", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
      await report(env, "twitch", 999, "https://www.twitch.tv/firstcreator");
      await report(env, "twitch", 1000, "https://www.twitch.tv/secondcreator", { playingVideoCount: 0 });
      expect(env.state.manualWatch?.twitch?.tabId).toBe(999);
      expect(env.state.sessions.twitch.reasonCode).toBe("manual_watch");
    });

    it("persists both manual tabs across controller recreation", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
      await report(env, "twitch", 999, "https://www.twitch.tv/firstcreator");
      await report(env, "twitch", 1000, "https://www.twitch.tv/secondcreator");
      const restored = createBackgroundController(hostPortsFromMocks(env.deps));
      await restored.handleTabRemoved(1000);
      await restored.settleBackgroundWork();
      expect(env.state.manualWatch?.twitch?.tabId).toBe(999);
      expect(env.state.sessions.twitch.reasonCode).toBe("manual_watch");
    });

    it("does not pause when manual-watch pausing is disabled", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: false }));
      await env.controller.tick();
      await report(env, "kick", 999, "https://kick.com/creator");
      expect(env.state.manualWatch?.kick).toBeUndefined();
      expect(env.state.sessions.kick.status).toBe("watching");
    });

    it.each([undefined, "https://example.com/creator", "https://clips.twitch.tv/SomeClip"])("requires a supported stream URL (%s)", async (url) => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
      await env.controller.tick();
      await env.controller.handleMessage({ type: "playbackTelemetry", platform: "twitch", telemetry }, { tab: { id: 999, url } });
      await env.controller.settleBackgroundWork();
      expect(env.state.manualWatch?.twitch?.active).not.toBe(true);
      expect(env.state.sessions.twitch.status).toBe("watching");
    });

    it("stays paused during navigation between stream channels", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
      await report(env, "twitch", 999, "https://www.twitch.tv/firstcreator");
      await env.controller.handleTabUpdated(999, "https://www.twitch.tv/secondcreator");
      await env.controller.settleBackgroundWork();
      expect(env.state.sessions.twitch.reasonCode).toBe("manual_watch");
      await report(env, "twitch", 999, "https://www.twitch.tv/secondcreator");
      expect(env.state.manualWatch?.twitch?.channel?.username).toBe("secondcreator");
    });

    it("resumes when a manual tab navigates to inventory before new telemetry", async () => {
      const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
      await report(env, "twitch", 999, "https://www.twitch.tv/creator");
      await env.controller.handleTabUpdated(999, "https://www.twitch.tv/drops/inventory");
      await env.controller.settleBackgroundWork();
      expect(env.state.sessions.twitch.status).toBe("watching");
    });
  });

  it("pauses Twitch immediately when visible playback starts in a non-managed tab", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
    await env.controller.tick();
    vi.mocked(env.kick.refreshCampaigns).mockClear();

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
    }, { tab: { id: 999, url: "https://www.twitch.tv/FirstCreator" } });

    expect(env.state.manualWatch?.twitch).toMatchObject({
      platform: "twitch",
      tabId: 999,
      active: true,
      channel: {
        platform: "twitch",
        username: "firstcreator",
        url: "https://www.twitch.tv/firstcreator",
      },
    });
    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      reasonCode: "manual_watch",
      channel: undefined,
    });
    expect(env.state.sessions.kick.status).toBe("watching");
    expect(env.kick.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.state.sessions.twitch.playback).toBeUndefined();
  });

  it("replaces or clears the manual Twitch channel when the same tab navigates", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
    const telemetry = {
      videoCount: 1,
      mutedVideoCount: 0,
      unmutedVideoCount: 1,
      playingVideoCount: 1,
      blockedPlaybackCount: 0,
      documentHidden: false,
    };

    await env.controller.handleMessage(
      { type: "playbackTelemetry", platform: "twitch", telemetry },
      { tab: { id: 999, url: "https://www.twitch.tv/FirstCreator" } },
    );
    await env.controller.settleBackgroundWork();
    await env.controller.handleMessage(
      { type: "playbackTelemetry", platform: "twitch", telemetry },
      { tab: { id: 999, url: "https://www.twitch.tv/SecondCreator" } },
    );

    expect(env.state.manualWatch?.twitch?.channel).toEqual({
      platform: "twitch",
      username: "secondcreator",
      url: "https://www.twitch.tv/secondcreator",
    });
    env.twitch.claimChannelPoints = vi.fn(async () => false);
    await env.controller.runTwitchChannelPointsClaim();
    expect(env.twitch.claimChannelPoints).toHaveBeenCalledWith(expect.objectContaining({
      username: "secondcreator",
    }));

    await env.controller.handleMessage(
      { type: "playbackTelemetry", platform: "twitch", telemetry },
      { tab: { id: 999, url: "https://www.twitch.tv/directory" } },
    );

    expect(env.state.manualWatch?.twitch?.channel).toBeUndefined();
  });

  it("runs only one immediate tick while the same manual playback stays active", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
    await env.controller.tick(["twitch"]);
    env.reportEvents.mockClear();
    const telemetry = {
      videoCount: 1,
      mutedVideoCount: 0,
      unmutedVideoCount: 1,
      playingVideoCount: 1,
      blockedPlaybackCount: 0,
      documentHidden: false,
    };

    await env.controller.handleMessage({ type: "playbackTelemetry", platform: "twitch", telemetry }, { tab: { id: 999, url: "https://www.twitch.tv/creator" } });
    await env.controller.handleMessage({ type: "playbackTelemetry", platform: "twitch", telemetry }, { tab: { id: 999, url: "https://www.twitch.tv/creator" } });

    const immediateTickStarts = allDiagnostics(env).filter((event) =>
      event.message.includes("started (trigger=manual_watch"));
    expect(immediateTickStarts).toHaveLength(1);
  });

  it("does not tick when non-managed Twitch playback is inactive", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
    await env.controller.tick(["twitch"]);
    env.reportEvents.mockClear();

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

    expect(env.state.sessions.twitch.status).toBe("watching");
    expect(allDiagnostics(env).some((event) =>
      event.message.includes("started (trigger=manual_watch"))).toBe(false);
  });

  it("clears manual watch activity when the source tab is closed", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
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
    const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
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

  // A clock rollback can leave the stored manual-watch `checkedAt` in the
  // future. Reading that as "recently active" would keep a stale record
  // winning over fresher telemetry from a different tab, so a future stamp
  // counts as stale and the new telemetry is applied instead.
  it("overrides manual watch activity stamped in the future with fresh telemetry", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, pauseOnManualWatch: true }));
    env.state.manualWatch = {
      twitch: {
        platform: "twitch",
        tabId: 999,
        active: true,
        checkedAt: new Date(Date.now() + 60 * 60_000).toISOString(),
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
    }, { tab: { id: 1000 } });

    expect(env.state.manualWatch?.twitch).toMatchObject({
      tabId: 1000,
      active: false,
    });
  });

  it("logs playback transitions such as ad starts and blocked playback", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });

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

    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    const messages = published.filter((event) => event.category === "diagnostic").map((event) => event.message);
    expect(messages).toContain("Ad started; keeping the watch tab counting down");
    expect(published.some((event) => event.category === "diagnostic" && event.level === "warn" && event.message.startsWith("Playback was blocked"))).toBe(true);
  });

  it("publishes focus diagnostics exactly once in the telemetry operation batch", async () => {
    const reported: EngineEvent[][] = [];
    const env = harness(farming(DEFAULT_SETTINGS), {
      reportEvents: async (events) => { reported.push([...events]); },
    });
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });
    reported.length = 0;
    env.deps.applyAdFocus.mockImplementation(async (_platform, _tabId, _adActive, emit) => {
      emit({ category: "diagnostic", level: "info", message: "focus-adjusted", platform: "twitch" });
    });

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

    const focusDiagnostics = reported
      .flatMap((events) => events)
      .filter((event) => event.category === "diagnostic" && event.message === "focus-adjusted");
    expect(focusDiagnostics).toHaveLength(1);
  });

  it("keeps persisted playback telemetry when applying ad focus fails", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });
    env.deps.applyAdFocus.mockRejectedValue(new Error("focus callback failed"));

    await expect(env.controller.handleMessage({
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
    }, { tab: { id: 10 } })).resolves.toBeUndefined();

    expect(env.state.sessions.twitch.playback?.adActive).toBe(true);
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: "focus callback failed",
    }));
  });

  it("focuses the watch tab when an ad is reported on the managed tab", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, adFocusMode: "window" }));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });
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

    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("twitch", 10, true, expect.any(Function));
  });

  it("releases ad focus when telemetry reports no ad", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, adFocusMode: "tab" }));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });
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

    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("twitch", 10, false, expect.any(Function));
  });

  it("does not focus for telemetry from a tab that is not the watch tab", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });
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
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });
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
    const published = env.reportEvents.mock.calls.flatMap(([events]) => events);
    expect(published.some((event) => event.category === "diagnostic" && event.message.startsWith("Ad started"))).toBe(false);
  });

  it("does not treat tabless sessions as managed playback telemetry targets", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
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
    }, { tab: { id: 10, url: "https://www.twitch.tv/creator" } });

    expect(env.state.sessions.twitch.playback).toBeUndefined();
    expect(env.state.manualWatch?.twitch).toMatchObject({
      tabId: 10,
      active: true,
    });
    expect(env.deps.applyAdFocus).not.toHaveBeenCalledWith(
      "twitch",
      10,
      true,
      expect.any(Function),
    );
  });

  it("re-applies ad focus from playback state on each scheduler tick", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.handleMessage({ type: "tickNow" });

    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("twitch", 10, false, expect.any(Function));
    expect(env.deps.applyAdFocus).toHaveBeenCalledWith("kick", 20, false, expect.any(Function));
  });

  it("applies ad focus only for each concurrent tick's own platform", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const twitchDiscovery = deferred<DropCampaign[]>();
    vi.mocked(env.twitch.refreshCampaigns).mockReturnValue(twitchDiscovery.promise);
    env.deps.applyAdFocus.mockClear();

    const ticking = env.controller.tick(undefined, "manual_tick");

    try {
      await vi.waitFor(() => {
        expect(env.deps.applyAdFocus).toHaveBeenCalledWith(
          "kick",
          20,
          false,
          expect.any(Function),
        );
      });
      expect(env.deps.applyAdFocus.mock.calls.map(([platform]) => platform)).toEqual(["kick"]);
    } finally {
      twitchDiscovery.resolve([campaign("twitch")]);
      await ticking;
    }

    expect(env.deps.applyAdFocus.mock.calls.map(([platform]) => platform)).toEqual([
      "kick",
      "twitch",
    ]);
  });

  it("keeps successful scheduler state when re-applying ad focus fails", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.deps.applyAdFocus.mockRejectedValue(new Error("focus refresh failed"));

    await env.controller.tick();

    expect(env.state.sessions.twitch.status).toBe("watching");
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: "focus refresh failed",
    }));
  });

  it("allows playback control only for the current watch tab", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });

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
    const env = harness(farming({ ...DEFAULT_SETTINGS, keepFarmingVideosUnmuted: false }));
    await env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: true });

    await expect(env.controller.handleMessage(
      { type: "getPlaybackControl", platform: "twitch" },
      { tab: { id: 10 } },
    )).resolves.toEqual({ managed: true, keepVideosUnmuted: false });
  });

  it("defaults playback control on when stored settings are missing the advanced flag", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.deps.loadSettings.mockResolvedValueOnce(farming({
      ...DEFAULT_SETTINGS,
      keepFarmingVideosUnmuted: undefined,
    } as unknown as typeof DEFAULT_SETTINGS));
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

  it("pauses the platform when the user closes the active managed farming tab", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
    };
    env.state.managedWatchTabs = {
      twitch: {
        platform: "twitch",
        tabId: 10,
        channelUrl: "https://www.twitch.tv/twitch-creator",
        ownedByExtension: true,
      },
    };

    await env.controller.handleTabRemoved(10);

    // The removal itself never runs the scheduler (#193).
    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.manualClosePause?.twitch).toMatchObject({ platform: "twitch" });
    expect(env.state.sessions.twitch).toMatchObject({
      platform: "twitch",
      status: "paused",
      reasonCode: "manual_tab_close",
    });
    expect(env.state.managedWatchTabs?.twitch).toBeUndefined();
    // The user's enabled/running settings are untouched: this is a pause.
    expect(isFarmingActive(env.settings)).toBe(true);
    expect(env.settings.platform.twitch.enabled).toBe(true);

    await env.controller.tick();

    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.sessions.twitch.status).toBe("paused");
    expect(env.state.sessions.twitch.reasonCode).toBe("manual_tab_close");
    // The other platform keeps farming.
    expect(env.kick.prepareWatchTab).toHaveBeenCalledOnce();
  });

  it("resumes farming for the platform when the user asks to resume", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
    };

    await env.controller.handleTabRemoved(10);
    expect(env.state.manualClosePause?.twitch).toBeDefined();

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "resumeAfterManualClose", platform: "twitch" }));

    expect(snapshot.state.manualClosePause?.twitch).toBeUndefined();
    expect(env.state.manualClosePause?.twitch).toBeUndefined();
    expect(env.twitch.prepareWatchTab).toHaveBeenCalledOnce();
    expect(env.state.sessions.twitch.status).toBe("watching");
  });

  it("does not pause when a watch tab the extension does not own is closed", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: false,
    };

    await env.controller.handleTabRemoved(10);

    expect(env.state.manualClosePause?.twitch).toBeUndefined();

    await env.controller.tick();

    expect(env.twitch.prepareWatchTab).toHaveBeenCalledOnce();
  });

  it("does not pause when a managed page-context tab is closed", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.kick = {
      platform: "kick",
      status: "watching",
      channel: channel("kick"),
      offlineChecks: 0,
      tabId: 20,
      tabManagedByExtension: true,
    };
    env.state.managedPageContextTabs = {
      kick: {
        platform: "kick",
        tabId: 91,
        originUrl: "https://kick.com/drops/inventory",
        origin: "https://kick.com",
        ownedByExtension: true,
      },
    };

    await env.controller.handleTabRemoved(91);

    expect(env.state.manualClosePause?.kick).toBeUndefined();

    await env.controller.tick();

    expect(env.kick.prepareWatchTab).toHaveBeenCalledOnce();
  });

  it("does not confuse a removed page-context tab with the active farming tab", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.kick = {
      platform: "kick",
      status: "watching",
      channel: channel("kick"),
      offlineChecks: 0,
      tabId: 20,
      tabManagedByExtension: true,
    };
    env.state.managedWatchTabs = {
      kick: {
        platform: "kick",
        tabId: 20,
        channelUrl: "https://kick.com/kick-creator",
        ownedByExtension: true,
      },
    };
    env.state.managedPageContextTabs = {
      kick: {
        platform: "kick",
        tabId: 91,
        originUrl: "https://kick.com/drops/inventory",
        origin: "https://kick.com",
        ownedByExtension: true,
      },
    };

    await env.controller.handleTabRemoved(91);

    expect(env.state.sessions.kick.tabId).toBe(20);
    expect(env.state.managedWatchTabs?.kick?.tabId).toBe(20);
    expect(env.kick.prepareWatchTab).not.toHaveBeenCalled();
  });

  it("ignores removed tabs that are not the active managed watch tab", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      channel: channel("twitch"),
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
    };

    await env.controller.handleTabRemoved(999);

    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
  });

  it("does not reopen a closed tab for a disabled platform", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false, idleWatchlistChannels: [] },
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

    expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
  });

  it("tracks one managed watch tab per running platform", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

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
});
