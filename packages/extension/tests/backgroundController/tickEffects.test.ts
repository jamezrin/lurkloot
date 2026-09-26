import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedWatchTab } from "@lurkloot/core/adapter";
import { DEFAULT_STATE } from "../../src/core/storage";
import { allDiagnostics, campaign, deferred, establishedTablessEnv, harness } from "../helpers/backgroundController";

// The scheduler tick runs its effects with no lock held (#599). Other writers
// commit while an effect is in flight; the tick's commit keeps their changes as
// if they ran after it, or drops its own decision when they contradict it.

const telemetry = {
  videoCount: 1,
  mutedVideoCount: 0,
  unmutedVideoCount: 1,
  playingVideoCount: 1,
  blockedPlaybackCount: 0,
  documentHidden: false,
};

describe("scheduler tick effects outside the lock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps playback telemetry that arrives while the watch tab opens", async () => {
    const env = harness();
    await env.controller.tick(["twitch"]);
    expect(env.state.sessions.twitch).toMatchObject({ status: "watching", tabId: 10 });

    const opening = deferred<PreparedWatchTab>();
    vi.mocked(env.twitch.prepareWatchTab).mockImplementationOnce(() => opening.promise);
    const ticking = env.controller.tick(["twitch"]);
    await vi.waitFor(() => expect(env.twitch.prepareWatchTab).toHaveBeenCalledTimes(2));

    // The platform lock is free while the tab opens, so telemetry commits now
    // instead of queueing behind the tick.
    await env.rawController.handleMessage({ type: "playbackTelemetry", platform: "twitch", telemetry }, { tab: { id: 10 } });
    expect(env.state.sessions.twitch.playback).toMatchObject({ playingVideoCount: 1 });

    opening.resolve({ tabId: 10, managedByExtension: true });
    await ticking;

    expect(env.state.sessions.twitch).toMatchObject({
      status: "watching",
      tabId: 10,
      playback: expect.objectContaining({ playingVideoCount: 1 }),
    });
    expect(allDiagnostics(env).map((event) => event.message)).not.toContainEqual(
      expect.stringContaining("Tick superseded"),
    );
  });

  it("drops a decision the user overrode by closing the tab, and closes the tab it opened", async () => {
    const env = harness();
    await env.controller.tick(["twitch"]);
    expect(env.state.managedWatchTabs?.twitch?.tabId).toBe(10);

    const opening = deferred<PreparedWatchTab>();
    vi.mocked(env.twitch.prepareWatchTab).mockImplementationOnce(() => opening.promise);
    const ticking = env.controller.tick(["twitch"]);
    await vi.waitFor(() => expect(env.twitch.prepareWatchTab).toHaveBeenCalledTimes(2));

    await env.rawController.handleTabRemoved(10);
    expect(env.state.manualClosePause?.twitch).toBeDefined();

    opening.resolve({ tabId: 11, managedByExtension: true });
    await ticking;
    await env.controller.settleBackgroundWork();

    expect(env.state.sessions.twitch).toMatchObject({ status: "paused", reasonCode: "manual_tab_close" });
    expect(env.state.managedWatchTabs?.twitch).toBeUndefined();
    expect(env.twitch.stopWatchTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 11, tabManagedByExtension: true }),
      expect.anything(),
    );
    expect(allDiagnostics(env).map((event) => event.message)).toContain(
      "Tick superseded before publication: the watch session changed",
    );
  });

  it("sends one claim request when a manual claim overlaps the tick's claim", async () => {
    const env = harness(undefined, {
      initialState: {
        ...DEFAULT_STATE,
        sessions: {
          twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
          kick: { platform: "kick", status: "idle", offlineChecks: 0 },
        },
        campaigns: { twitch: [campaign("twitch", "claimable")], kick: [] },
      },
    });
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([campaign("twitch", "claimable")]);
    const claiming = deferred<boolean>();
    vi.mocked(env.twitch.claimReward).mockImplementationOnce(() => claiming.promise);

    const ticking = env.controller.tick(["twitch"]);
    await vi.waitFor(() => expect(env.twitch.claimReward).toHaveBeenCalledOnce());
    await env.rawController.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: "reward",
    });

    claiming.resolve(true);
    await ticking;
    await env.controller.settleBackgroundWork();

    expect(env.twitch.claimReward).toHaveBeenCalledOnce();
    expect(allDiagnostics(env).map((event) => event.message)).toContain("Reward is already being claimed");
    expect(env.state.campaigns.twitch[0].rewards[0].status).toBe("claimed");
  });

  it("starts no effect once a host reset aborts the tick", async () => {
    const env = harness();
    await env.controller.tick(["twitch"]);
    const claimChannelPoints = vi.fn(async () => true);
    env.twitch.claimChannelPoints = claimChannelPoints;
    const opening = deferred<PreparedWatchTab>();
    vi.mocked(env.twitch.prepareWatchTab).mockImplementationOnce(() => opening.promise);
    const ticking = env.controller.tick(["twitch"]);
    await vi.waitFor(() => expect(env.twitch.prepareWatchTab).toHaveBeenCalledTimes(2));

    // Reset no longer waits for the tick's lock: the tab is still opening.
    await env.rawController.prepareForHostReset();
    const saves = env.deps.saveState.mock.calls.length;
    opening.resolve({ tabId: 11, managedByExtension: true });
    await ticking;

    // Not even the clean-up a stale selection would ask for: an aborted tick
    // starts nothing, as when it used to wait out the reset behind its lock.
    expect(env.twitch.stopWatchTab).not.toHaveBeenCalledWith(expect.objectContaining({ tabId: 11 }), expect.anything());
    expect(claimChannelPoints).not.toHaveBeenCalled();
    expect(env.deps.saveState.mock.calls.length).toBe(saves);
    expect(env.state.managedWatchTabs?.twitch?.tabId).not.toBe(11);
  });

  it("keeps a tabless tick current when a heartbeat commits during its channel-points claim", async () => {
    const { env } = await establishedTablessEnv("twitch");
    const claiming = deferred<boolean>();
    env.twitch.claimChannelPoints = vi.fn(() => claiming.promise);
    const firstCheckedAt = env.state.sessions.twitch.lastCheckedAt;

    const ticking = env.controller.tick(["twitch"]);
    await vi.waitFor(() => expect(env.twitch.claimChannelPoints).toHaveBeenCalledOnce());
    await env.controller.runWatchHeartbeat();
    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    claiming.resolve(false);
    await ticking;

    expect(allDiagnostics(env).map((event) => event.message)).not.toContainEqual(
      expect.stringContaining("Tick superseded"),
    );
    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    expect(Date.parse(env.state.sessions.twitch.lastCheckedAt ?? "")).toBeGreaterThan(Date.parse(firstCheckedAt ?? ""));
  });
});
