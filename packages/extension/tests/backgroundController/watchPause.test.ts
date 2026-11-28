import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WATCH_PAUSE_ALARM_NAME } from "@lurkloot/core/controller";
import { WATCH_PAUSE_RECHECK_MS } from "@lurkloot/core/background/watchPause";
import type { ExtensionSettings } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import type { WatchPauseSchedule } from "@lurkloot/shared/watchPauseSchedule";
import { campaign, channel, farming, harness } from "../helpers/backgroundController";

// The daily watch pause window (#1162) through the controller's normal entry
// points: startup, a settings save, the boundary job and the tick alarms. The
// clock is faked (Date only), so every boundary is deterministic.

const WINDOW: WatchPauseSchedule = {
  enabled: true,
  start: "22:00",
  end: "06:00",
  timeZone: "UTC",
};

function withSchedule(schedule: WatchPauseSchedule = WINDOW): ExtensionSettings {
  return farming({ ...DEFAULT_SETTINGS, watchPauseSchedule: schedule });
}

function watching(env: ReturnType<typeof harness>, platform: "twitch" | "kick", tabId: number) {
  env.state.sessions[platform] = {
    platform,
    status: "watching",
    channel: channel(platform),
    campaignId: `${platform}-campaign`,
    rewardId: "reward",
    offlineChecks: 0,
    tabId,
    tabManagedByExtension: true,
  };
  env.state.managedWatchTabs = {
    ...env.state.managedWatchTabs,
    [platform]: {
      platform,
      tabId,
      channelUrl: channel(platform).url,
      ownedByExtension: true,
    },
  };
}

function boundaryArms(env: ReturnType<typeof harness>): number[] {
  return env.deps.createAlarm.mock.calls
    .filter(([name]) => name === WATCH_PAUSE_ALARM_NAME)
    .map(([, schedule]) => (schedule as { when: number }).when);
}

describe("daily watch pause", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops managed watches and opens none while the window applies", async () => {
    vi.setSystemTime("2026-07-01T23:00:00Z");
    const env = harness(withSchedule());
    watching(env, "twitch", 44);

    await env.controller.tick(undefined, "alarm");

    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      reasonCode: "scheduled_pause",
      tabId: undefined,
      channel: undefined,
    });
    expect(env.state.sessions.kick).toMatchObject({
      status: "paused",
      reasonCode: "scheduled_pause",
    });
    expect(env.deps.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "twitch", tabId: 44 }),
      expect.anything(),
      expect.anything(),
    );
    expect(env.state.managedWatchTabs?.twitch).toBeUndefined();
    expect(env.deps.openWatchTab).not.toHaveBeenCalled();
    // Account health and discovery keep running.
    expect(env.state.authHealth.twitch.status).toBe("healthy");
    expect(env.twitch.refreshCampaigns).toHaveBeenCalled();
  });

  it("closes a managed tab whatever the auto-close setting says", async () => {
    vi.setSystemTime("2026-07-01T23:00:00Z");
    const env = harness({ ...withSchedule(), autoCloseFinishedDrops: false });
    watching(env, "twitch", 44);

    await env.controller.tick(["twitch"], "alarm");

    // Handing the tab back would unmute a stream inside the window.
    expect(env.deps.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 44, tabManagedByExtension: true }),
      expect.objectContaining({ closeManagedTabs: true }),
      expect.anything(),
    );
  });

  it("keeps owning a tab the browser would not close, and replaces it only after", async () => {
    vi.setSystemTime("2026-07-01T23:00:00Z");
    const env = harness(withSchedule());
    watching(env, "twitch", 44);
    env.watchTabs.twitch.stop.mockResolvedValue("still_open");

    for (let minute = 0; minute < 4 * 60; minute += 5) {
      vi.setSystemTime(Date.parse("2026-07-01T23:00:00Z") + minute * 60_000);
      await env.controller.tick(["twitch"], "alarm");
    }

    // Every paused tick retries the close of the same tab and opens nothing.
    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      reasonCode: "scheduled_pause",
      tabId: 44,
      tabManagedByExtension: true,
      channel: undefined,
    });
    expect(env.state.managedWatchTabs?.twitch?.tabId).toBe(44);
    expect(env.watchTabs.twitch.stop).toHaveBeenCalledTimes(48);
    expect(env.watchTabs.twitch.stop.mock.calls.every(([session]) => session.tabId === 44)).toBe(
      true,
    );
    expect(env.deps.openWatchTab).not.toHaveBeenCalled();

    // The window ends: the open is handed the tab still held, so the host
    // closes it before it opens a replacement instead of opening beside it.
    vi.setSystemTime("2026-07-02T06:00:01Z");
    await env.controller.tick(["twitch"], "alarm");
    expect(env.deps.openWatchTab).toHaveBeenCalledOnce();
    expect(env.deps.openWatchTab).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tabId: 44, tabManagedByExtension: true }),
      expect.objectContaining({ managedTab: expect.objectContaining({ tabId: 44 }) }),
      expect.anything(),
    );
  });

  it("stops the watch while the platform waits out an error backoff", async () => {
    vi.setSystemTime("2026-07-01T23:00:00Z");
    const env = harness(withSchedule());
    watching(env, "twitch", 44);
    const retryAfter = "2026-07-01T23:20:00Z";
    env.state.sessions.twitch = {
      ...env.state.sessions.twitch,
      status: "error",
      errorChecks: 2,
      retryAfter,
      reasonCode: "platform_error",
    };

    await env.controller.tick(["twitch"], "alarm");

    expect(env.deps.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 44 }),
      expect.objectContaining({ closeManagedTabs: true }),
      expect.anything(),
    );
    // The backoff itself is left alone.
    expect(env.state.sessions.twitch).toMatchObject({
      status: "error",
      reasonCode: "platform_backoff",
      errorChecks: 2,
      retryAfter,
      tabId: undefined,
      channel: undefined,
    });
    expect(env.state.managedWatchTabs?.twitch).toBeUndefined();
    expect(env.deps.openWatchTab).not.toHaveBeenCalled();
  });

  it("stops the watch before an auth challenge fails the tick", async () => {
    vi.setSystemTime("2026-07-01T23:00:00Z");
    const env = harness(withSchedule());
    watching(env, "twitch", 44);
    vi.mocked(env.twitch.checkAuthHealth).mockResolvedValue({
      status: "unavailable",
      reasonCode: "request_challenged",
      checkedAt: new Date().toISOString(),
    });

    await env.controller.tick(["twitch"], "alarm");

    expect(env.deps.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 44 }),
      expect.objectContaining({ closeManagedTabs: true }),
      expect.anything(),
    );
    expect(env.state.sessions.twitch).toMatchObject({
      status: "error",
      reasonCode: "platform_error",
      tabId: undefined,
      channel: undefined,
    });
    expect(env.state.managedWatchTabs?.twitch).toBeUndefined();
  });

  it("still claims rewards during the window", async () => {
    vi.setSystemTime("2026-07-01T23:00:00Z");
    const env = harness(withSchedule());
    env.twitch.refreshCampaigns = vi.fn(async () => [campaign("twitch", "claimable")]);

    await env.controller.tick(["twitch"], "alarm");

    expect(env.twitch.claimReward).toHaveBeenCalled();
    expect(env.state.sessions.twitch.reasonCode).toBe("scheduled_pause");
    expect(env.deps.openWatchTab).not.toHaveBeenCalled();
  });

  it("resumes on the first tick after the window ends", async () => {
    vi.setSystemTime("2026-07-01T23:00:00Z");
    const env = harness(withSchedule());
    await env.controller.tick(undefined, "alarm");
    expect(env.state.sessions.twitch.reasonCode).toBe("scheduled_pause");

    vi.setSystemTime("2026-07-02T06:00:01Z");
    await env.controller.runJob(WATCH_PAUSE_ALARM_NAME);
    await env.controller.settleBackgroundWork();

    expect(env.state.sessions.twitch.status).toBe("watching");
    expect(env.state.sessions.kick.status).toBe("watching");
    expect(env.deps.openWatchTab).toHaveBeenCalledTimes(2);
    // Re-armed for tonight's start.
    expect(boundaryArms(env).at(-1)).toBe(
      Math.min(Date.parse("2026-07-02T22:00:01Z"), Date.now() + WATCH_PAUSE_RECHECK_MS),
    );
  });

  it("pauses on startup inside the window without reopening the tabs it left", async () => {
    vi.setSystemTime("2026-07-02T02:00:00Z");
    const env = harness(withSchedule());
    watching(env, "twitch", 44);

    await env.controller.handleStartup();
    await env.controller.settleBackgroundWork();

    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      reasonCode: "scheduled_pause",
    });
    expect(env.deps.openWatchTab).not.toHaveBeenCalled();
    expect(boundaryArms(env)).toContain(Date.parse("2026-07-02T02:15:00Z"));
  });

  it("keeps a manual pause and a disabled platform when the window ends", async () => {
    vi.setSystemTime("2026-07-01T23:00:00Z");
    const settings = withSchedule();
    const env = harness({
      ...settings,
      platform: { ...settings.platform, kick: { ...settings.platform.kick, enabled: false } },
    });
    env.state.manualClosePause = {
      twitch: { platform: "twitch", closedAt: "2026-07-01T21:00:00Z" },
    };
    await env.controller.tick(undefined, "alarm");

    vi.setSystemTime("2026-07-02T07:00:00Z");
    await env.controller.tick(undefined, "alarm");
    await env.controller.runJob(WATCH_PAUSE_ALARM_NAME);
    await env.controller.settleBackgroundWork();

    expect(env.state.sessions.twitch).toMatchObject({
      status: "paused",
      reasonCode: "manual_tab_close",
    });
    expect(env.state.manualClosePause?.twitch).toBeDefined();
    expect(env.state.sessions.kick.reasonCode).toBe("platform_disabled");
    expect(env.settings.platform.kick.enabled).toBe(false);
    expect(env.deps.openWatchTab).not.toHaveBeenCalled();
  });

  it("pauses at once when a settings save puts now inside a window", async () => {
    vi.setSystemTime("2026-07-01T12:00:00Z");
    const env = harness(withSchedule({ ...WINDOW, enabled: false }));
    await env.controller.tick(undefined, "alarm");
    expect(env.state.sessions.twitch.status).toBe("watching");
    expect(boundaryArms(env)).toEqual([]);

    await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: {
        watchPauseSchedule: { enabled: true, start: "11:00", end: "13:00", timeZone: "UTC" },
      },
      tickAfterSave: false,
    });
    await env.controller.settleBackgroundWork();

    expect(env.state.sessions.twitch.reasonCode).toBe("scheduled_pause");
    expect(env.state.sessions.kick.reasonCode).toBe("scheduled_pause");
    expect(boundaryArms(env).at(-1)).toBe(Date.parse("2026-07-01T12:15:00Z"));

    // Switching it off again resumes and cancels the job.
    env.deps.clearAlarm.mockClear();
    await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { watchPauseSchedule: { ...WINDOW, enabled: false } },
      tickAfterSave: false,
    });
    await env.controller.settleBackgroundWork();
    expect(env.state.sessions.twitch.status).toBe("watching");
    expect(env.deps.clearAlarm).toHaveBeenCalledWith(WATCH_PAUSE_ALARM_NAME);
  });

  it("catches up when the host slept through a boundary", async () => {
    vi.setSystemTime("2026-07-01T12:00:00Z");
    const env = harness(withSchedule());
    await env.controller.tick(undefined, "alarm");
    expect(env.state.sessions.twitch.status).toBe("watching");

    // The job was armed for the recheck; the host wakes long after the start.
    vi.setSystemTime("2026-07-02T03:00:00Z");
    await env.controller.runJob(WATCH_PAUSE_ALARM_NAME);
    await env.controller.settleBackgroundWork();
    expect(env.state.sessions.twitch.reasonCode).toBe("scheduled_pause");

    // Asleep through the whole of the next window: nothing to change.
    await env.controller.runJob(WATCH_PAUSE_ALARM_NAME);
    await env.controller.settleBackgroundWork();
    vi.setSystemTime("2026-07-03T12:00:00Z");
    await env.controller.runJob(WATCH_PAUSE_ALARM_NAME);
    await env.controller.settleBackgroundWork();
    expect(env.state.sessions.twitch.status).toBe("watching");
  });

  it("opens tabs only outside the window over two days of ticks", async () => {
    vi.setSystemTime("2026-07-01T00:00:00Z");
    const env = harness(withSchedule());
    const inWindow = () => {
      const hour = new Date().getUTCHours();
      return hour >= 22 || hour < 6;
    };
    const opensInWindow: string[] = [];
    let opensOutside = 0;
    env.deps.openWatchTab.mockImplementation(async (candidate) => {
      if (inWindow()) opensInWindow.push(new Date().toISOString());
      else opensOutside += 1;
      return { tabId: candidate.platform === "twitch" ? 10 : 20, managedByExtension: true };
    });

    const start = Date.now();
    const pausedTicks: boolean[] = [];
    for (let minute = 0; minute <= 48 * 60; minute += 5) {
      vi.setSystemTime(start + minute * 60_000);
      await env.controller.tick(undefined, "alarm");
      await env.controller.runJob(WATCH_PAUSE_ALARM_NAME);
      await env.controller.settleBackgroundWork();
      if (inWindow())
        pausedTicks.push(
          env.state.sessions.twitch.reasonCode === "scheduled_pause"
            && env.state.sessions.kick.reasonCode === "scheduled_pause",
        );
    }

    expect(opensInWindow).toEqual([]);
    expect(opensOutside).toBeGreaterThan(0);
    expect(pausedTicks.length).toBeGreaterThan(0);
    expect(pausedTicks.every(Boolean)).toBe(true);
  });
});
