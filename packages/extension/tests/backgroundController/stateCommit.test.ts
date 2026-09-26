import { afterEach, describe, expect, it, vi } from "vitest";
import type { DropCampaign, ExtensionSettings, SchedulerState } from "@lurkloot/shared/models";
import type { CommittedChange } from "@lurkloot/core/controller";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { campaign, channel, deferred, farming, harness } from "../helpers/backgroundController";

// Platform locks and state commits: one platform's work does not hold the other's.

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls after-commit hooks with each accepted settings and state commit", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const changes: CommittedChange<ExtensionSettings>[] = [];
    env.controller.onCommit((change) => {
      changes.push(change);
    });

    await env.controller.handleMessage({
      type: "saveSettings",
      settingsPatch: { priorityMode: "lowest_availability" },
      tickAfterSave: true,
      tickAfterSavePlatforms: ["twitch"],
    });
    await vi.waitFor(() => expect(changes.some((change) => change.kind === "state")).toBe(true));

    expect(changes[0]).toEqual(expect.objectContaining({
      kind: "settings",
      effects: { twitch: "selection", kick: "selection" },
    }));
    await env.controller.settleBackgroundWork();
    const last = changes.at(-1);
    expect(last).toEqual(expect.objectContaining({ kind: "state" }));
    expect(changes.slice(1).every((change) => change.kind === "state" && change.platforms.includes("twitch"))).toBe(true);
  });

  it("serializes concurrent state writers so neither update is lost", async () => {
    const env = harness();
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
    };

    // Model storage snapshot semantics: each load returns an isolated copy, so
    // an unserialized handler building on a stale snapshot would clobber a newer
    // save. Trace load/save ordering to prove the lock serializes them.
    const trace: string[] = [];
    const originalSave = env.deps.saveState.getMockImplementation()!;
    env.deps.loadState.mockImplementation(async () => {
      trace.push("load");
      return structuredClone(env.state);
    });
    env.deps.saveState.mockImplementation(async (next: SchedulerState) => {
      trace.push("save");
      await Promise.resolve();
      await originalSave(next);
    });

    await Promise.all([
      env.controller.handleMessage(
        {
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
        },
        { tab: { id: 10 } },
      ),
      env.controller.tick(),
    ]);

    expect(trace.filter((entry) => entry === "load").length)
      .toBeGreaterThanOrEqual(trace.filter((entry) => entry === "save").length);
    // Both writers' changes survive in the final persisted state.
    expect(env.state.sessions.twitch.playback).toBeDefined();
    expect(env.state.lastTickAt).toBeDefined();
  });

  it("lets Kick complete while Twitch discovery is still pending", async () => {
    const env = harness();
    const twitchDiscovery = deferred<DropCampaign[]>();
    env.twitch.refreshCampaigns = vi.fn(() => twitchDiscovery.promise);

    const ticking = env.controller.tick(undefined, "manual_tick");

    try {
      await vi.waitFor(() => expect(env.kick.refreshCampaigns).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(env.state.sessions.kick.lastCheckedAt).toBeDefined());
      expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    } finally {
      twitchDiscovery.resolve([]);
      await ticking;
    }
  });

  it("lets a Kick auth refresh start while Twitch scheduler work is pending", async () => {
    const env = harness();
    const twitchDiscovery = deferred<DropCampaign[]>();
    env.twitch.refreshCampaigns = vi.fn(() => twitchDiscovery.promise);

    const ticking = env.controller.tick(["twitch"], "manual_tick");
    await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
    const checkingKick = env.controller.checkAuthHealth("kick");
    let kickRefreshCompleted = false;
    void checkingKick.then(() => {
      kickRefreshCompleted = true;
    });
    try {
      await vi.waitFor(() => expect(env.kick.checkAuthHealth).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(kickRefreshCompleted).toBe(true));
    } finally {
      twitchDiscovery.resolve([]);
      await Promise.all([ticking, checkingKick]);
    }
  });

  it("lets Kick scheduler work complete while Twitch playback focus is pending", async () => {
    const focus = deferred<void>();
    const env = harness();
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
      channel: channel("twitch"),
    };
    env.deps.applyAdFocus.mockImplementation(async (platform) => {
      if (platform === "twitch") await focus.promise;
    });
    const telemetry = env.rawController.handleMessage({
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
    }, { tab: { id: 10 } });
    await vi.waitFor(() => expect(env.deps.applyAdFocus).toHaveBeenCalledWith(
      "twitch",
      10,
      false,
      expect.any(Function),
    ));

    const kickTick = env.rawController.tick(["kick"], "manual_tick");
    try {
      await vi.waitFor(() => expect(env.state.sessions.kick.lastCheckedAt).toBeDefined());
      expect(env.state.sessions.twitch.playback?.videoCount).toBe(1);
    } finally {
      focus.resolve();
      await Promise.all([telemetry, kickTick]);
    }

    expect(env.state.sessions.twitch.playback?.videoCount).toBe(1);
    expect(env.state.sessions.kick.lastCheckedAt).toBeDefined();
  });

  it("lets Kick scheduler work complete while a Twitch manual claim is pending", async () => {
    const claim = deferred<boolean>();
    const env = harness(farming({ ...DEFAULT_SETTINGS, autoClaim: false }));
    env.state.campaigns.twitch = [campaign("twitch", "claimable")];
    vi.mocked(env.twitch.claimReward).mockReturnValue(claim.promise);

    const claiming = env.rawController.handleMessage({
      type: "claimReward",
      platform: "twitch",
      campaignId: "twitch-campaign",
      rewardId: "reward",
    });
    await vi.waitFor(() => expect(env.twitch.claimReward).toHaveBeenCalledOnce());

    const kickTick = env.rawController.tick(["kick"], "manual_tick");
    try {
      await vi.waitFor(() => expect(env.state.sessions.kick.lastCheckedAt).toBeDefined());
      expect(env.state.campaigns.twitch[0].rewards[0].status).toBe("claimable");
    } finally {
      claim.resolve(true);
      await Promise.all([claiming, kickTick]);
    }

    expect(env.state.sessions.kick.lastCheckedAt).toBeDefined();
    expect(env.state.campaigns.twitch[0].rewards[0].status).toBe("claimed");
  });

  it("serializes handleTabRemoved against a concurrent tick so neither write is lost", async () => {
    const env = harness();
    env.state.manualWatch = {
      kick: { platform: "kick", tabId: 50, checkedAt: new Date().toISOString(), active: true },
    };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      tabId: 10,
      tabManagedByExtension: true,
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
    };

    // Same snapshot-isolation trace as the writer-serialization test above: an
    // unserialized handleTabRemoved would build on a stale snapshot and clobber
    // tick()'s save (or vice versa).
    const trace: string[] = [];
    const originalSave = env.deps.saveState.getMockImplementation()!;
    env.deps.loadState.mockImplementation(async () => {
      trace.push("load");
      return structuredClone(env.state);
    });
    env.deps.saveState.mockImplementation(async (next: SchedulerState) => {
      trace.push("save");
      await Promise.resolve();
      await originalSave(next);
    });

    await Promise.all([
      env.controller.handleTabRemoved(50),
      env.controller.tick(),
    ]);

    expect(trace.filter((entry) => entry === "load").length)
      .toBeGreaterThanOrEqual(trace.filter((entry) => entry === "save").length);
    // Both writers' changes survive: the manual-watch entry is removed AND the
    // concurrent tick committed its progress.
    expect(env.state.manualWatch?.kick).toBeUndefined();
    expect(env.state.lastTickAt).toBeDefined();
  });
});
