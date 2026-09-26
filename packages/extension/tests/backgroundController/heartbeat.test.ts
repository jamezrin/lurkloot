import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCompatibility } from "@lurkloot/core";
import { heartbeatContextKey } from "@lurkloot/core/heartbeatCadence";
import type { DropCampaign, SchedulerState, WatchSession } from "@lurkloot/shared/models";
import type { DiagnosticEvent, EngineEvent } from "@lurkloot/shared/events";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { createKickFetcher } from "@lurkloot/core/kick";
import { KickWatcher } from "@lurkloot/core/kick/watch";
import { kickAdapter } from "../helpers/adapters";
import type { TablessWatchController } from "@lurkloot/core/tablessWatch";
import { selectWatchTargetFromSnapshot } from "@lurkloot/core/scheduler";
import { recordManagedPageContextFallback, registerManagedPageContextTabs } from "@lurkloot/core/tabs";
import {
  adapter,
  advanceToNextHeartbeatDue,
  aggregateHeartbeatDiagnostics,
  allDiagnostics,
  campaign,
  channel,
  deferred,
  drainMicrotasks,
  dueHeartbeatCadence,
  establishedTablessEnv,
  fakeTablessWatcher,
  farming,
  harness,
  lastAggregateDiagnostic,
  reward,
  tablessEnv,
  twitchOperation,
} from "../helpers/backgroundController";

// Tabless watchers and heartbeats.

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops a tabless watcher without another heartbeat when authentication degrades", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false },
      },
    });
    env.twitch.supportsTabless = true;
    env.twitch.createTablessWatcher = vi.fn(() => watcher);

    await env.controller.tick();
    expect(env.state.sessions.twitch.watchMode).toBe("tabless");
    env.state.authHealth.twitch = {
      status: "invalid_credentials",
      checkedAt: "2026-07-22T12:00:00.000Z",
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    };

    await env.controller.runWatchHeartbeat();

    expect(watcher.stop).toHaveBeenCalledOnce();
    expect(watcher.tick).not.toHaveBeenCalled();
  });

  describe("tabless heartbeat cadence", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function cadenceEnv(
      heartbeat: () => Promise<{ ok: boolean; live?: boolean; message?: string }>,
    ) {
      const watcher = fakeTablessWatcher(heartbeat);
      const env = tablessEnv();
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      await env.controller.tick(["twitch"]);
      return { env, watcher };
    }

    function aggregateHeartbeatDiagnostics(env: ReturnType<typeof harness>): string[] {
      return allDiagnostics(env)
        .map((event) => event.message)
        .filter((message) => message.startsWith("Tabless heartbeat timing "));
    }

    it("keeps heartbeat cadence anchored to the scheduled due time after slow completion", async () => {
      const result = deferred<{ ok: boolean; live?: boolean; message?: string }>();
      const { env, watcher } = await cadenceEnv(() => result.promise);
      vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));

      const heartbeat = env.controller.runWatchHeartbeat();
      await drainMicrotasks();
      expect(watcher.tick).toHaveBeenCalledOnce();
      vi.setSystemTime(new Date("2026-09-02T12:01:07.000Z"));
      result.resolve({ ok: true, live: true });
      await heartbeat;

      expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt)
        .toBe("2026-09-02T12:02:00.000Z");
    });

    it("skips missed heartbeat slots after a late wake without a catch-up burst", async () => {
      const { env, watcher } = await cadenceEnv(async () => ({ ok: true, live: true }));
      vi.setSystemTime(new Date("2026-09-02T12:04:15.000Z"));

      await env.controller.runWatchHeartbeat();

      expect(watcher.tick).toHaveBeenCalledOnce();
      expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt)
        .toBe("2026-09-02T12:05:00.000Z");
    });

    it("coalesces three concurrent heartbeat calls into one transport attempt", async () => {
      const result = deferred<{ ok: boolean; live?: boolean; message?: string }>();
      const { env, watcher } = await cadenceEnv(() => result.promise);
      vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));

      const firstHeartbeat = env.controller.runWatchHeartbeat();
      await drainMicrotasks();
      expect(watcher.tick).toHaveBeenCalledOnce();
      const heartbeats = [
        firstHeartbeat,
        env.controller.runWatchHeartbeat(),
        env.controller.runWatchHeartbeat(),
      ];
      await drainMicrotasks();
      result.resolve({ ok: true, live: true });
      await Promise.all(heartbeats);

      expect(watcher.tick).toHaveBeenCalledOnce();
      expect(aggregateHeartbeatDiagnostics(env)).toEqual([
        expect.stringContaining("coalescedCalls=2"),
      ]);
    });

    it("performs no heartbeat transport before the scheduled due time", async () => {
      const { env, watcher } = await cadenceEnv(async () => ({ ok: true, live: true }));
      vi.setSystemTime(new Date("2026-09-02T12:00:59.999Z"));

      await env.controller.runWatchHeartbeat();

      expect(watcher.tick).not.toHaveBeenCalled();
      expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt)
        .toBe("2026-09-02T12:01:00.000Z");
      expect(aggregateHeartbeatDiagnostics(env)).toEqual([]);
    });

    it("emits exactly one aggregate heartbeat timing diagnostic per attempt", async () => {
      const result = deferred<{ ok: boolean; live?: boolean; message?: string }>();
      const { env, watcher } = await cadenceEnv(() => result.promise);
      vi.setSystemTime(new Date("2026-09-02T12:04:15.000Z"));

      const firstHeartbeat = env.controller.runWatchHeartbeat();
      await drainMicrotasks();
      expect(watcher.tick).toHaveBeenCalledOnce();
      const heartbeats = [
        firstHeartbeat,
        env.controller.runWatchHeartbeat(),
        env.controller.runWatchHeartbeat(),
      ];
      await drainMicrotasks();
      result.resolve({ ok: true, live: true });
      await Promise.all(heartbeats);

      expect(aggregateHeartbeatDiagnostics(env)).toEqual([
        expect.stringMatching(
          /scheduledDueAt=2026-09-02T12:01:00.000Z actualAttemptAt=2026-09-02T12:04:15.000Z latenessMs=195000 synchronizationDelayMs=\d+ coalescedCalls=2 outcome=ok staleResult=false/,
        ),
      ]);
    });
  });

  it.each([
    { outcome: "success", result: { ok: true, live: true } },
    { outcome: "failure", result: { ok: false, live: true, message: "old heartbeat rejected" } },
  ] as const)(
    "rejects a stale heartbeat $outcome without changing the replacement session",
    async ({ outcome, result }) => {
      const oldResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
      const oldWatcher = fakeTablessWatcher(() => oldResult.promise);
      const newWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = tablessEnv({ tablessFallbackFailureLimit: 1 });
      env.twitch.createTablessWatcher = vi.fn()
        .mockReturnValueOnce(oldWatcher)
        .mockReturnValueOnce(newWatcher);
      env.state.authHealth.twitch = { status: "healthy" };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        offlineChecks: 0,
        watchMode: "tabless",
        channel: channel("twitch", { broadcastId: "old-broadcast" }),
        campaignId: "old-campaign",
        rewardId: "old-reward",
        heartbeatChecks: outcome === "success" ? 1 : 0,
        lastHeartbeatAt: "2026-09-02T11:59:00.000Z",
        lastHeartbeatOk: false,
      };
      env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.twitch);

      const oldHeartbeat = env.controller.runWatchHeartbeat();
      await vi.waitFor(() => expect(oldWatcher.tick).toHaveBeenCalledOnce());
      env.reportEvents.mockClear();
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        offlineChecks: 0,
        watchMode: "tabless",
        channel: channel("twitch", {
          username: "new-creator",
          url: "https://www.twitch.tv/new-creator",
          broadcastId: "new-broadcast",
        }),
        campaignId: "new-campaign",
        rewardId: "new-reward",
        heartbeatChecks: 0,
      };
      const replacementHeartbeat = env.controller.runWatchHeartbeat();
      await vi.waitFor(() => expect(newWatcher.tick).toHaveBeenCalledOnce());

      oldResult.resolve(result);
      await Promise.all([oldHeartbeat, replacementHeartbeat]);

      expect(env.state.sessions.twitch).toMatchObject({
        channel: expect.objectContaining({
          username: "new-creator",
          broadcastId: "new-broadcast",
        }),
        campaignId: "new-campaign",
        rewardId: "new-reward",
        heartbeatChecks: 0,
        lastHeartbeatOk: true,
        tablessHeartbeat: expect.objectContaining({ generation: 2 }),
      });
      expect(env.state.sessions.twitch.lastHeartbeatAt).toBeDefined();
      expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
      const diagnostics = allDiagnostics(env).map((event) => event.message);
      expect(diagnostics).not.toContain("Tabless watch heartbeat recovered");
      expect(diagnostics).not.toContain("old heartbeat rejected");
      expect(diagnostics).not.toContain(
        "Tabless watch heartbeat keeps failing; falling back to a watch tab",
      );
      expect(env.reportEvents.mock.calls
        .flatMap(([events]) => events)
        .filter((event) => event.category === "activity")).toEqual([]);
      expect(aggregateHeartbeatDiagnostics(env, "twitch")).toHaveLength(2);
      expect(lastAggregateDiagnostic(env, "twitch")).toContain(
        `outcome=${outcome === "success" ? "ok" : "failed"}`,
      );
      expect(lastAggregateDiagnostic(env, "twitch")).toContain("staleResult=true");
    },
  );

  it("rejects a stale heartbeat after the same context advances generation", async () => {
    const oldResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
    const watcher = fakeTablessWatcher(() => oldResult.promise);
    const env = tablessEnv({ tablessFallbackFailureLimit: 1 });
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch", { broadcastId: "same-broadcast" }),
      campaignId: "same-campaign",
      rewardId: "same-reward",
      heartbeatChecks: 0,
    };
    env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.twitch);

    const heartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalledOnce());
    env.reportEvents.mockClear();
    env.state.sessions.twitch = {
      ...env.state.sessions.twitch,
      lastHeartbeatAt: "2026-09-02T12:00:30.000Z",
      lastHeartbeatOk: true,
      tablessHeartbeat: {
        ...env.state.sessions.twitch.tablessHeartbeat!,
        generation: 2,
      },
    };

    oldResult.resolve({ ok: false, live: true, message: "obsolete generation failed" });
    await heartbeat;

    expect(env.state.sessions.twitch).toMatchObject({
      channel: expect.objectContaining({ broadcastId: "same-broadcast" }),
      campaignId: "same-campaign",
      rewardId: "same-reward",
      heartbeatChecks: 0,
      lastHeartbeatAt: "2026-09-02T12:00:30.000Z",
      lastHeartbeatOk: true,
      tablessHeartbeat: expect.objectContaining({ generation: 2 }),
    });
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(allDiagnostics(env).map((event) => event.message))
      .not.toContain("obsolete generation failed");
    expect(aggregateHeartbeatDiagnostics(env, "twitch")).toHaveLength(1);
    expect(lastAggregateDiagnostic(env, "twitch")).toContain("outcome=failed");
    expect(lastAggregateDiagnostic(env, "twitch")).toContain("staleResult=true");
  });

  it("replaces a Kick watcher when the same channel URL changes category", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const oldResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
    const oldWatcher = fakeTablessWatcher(() => oldResult.promise, "kick");
    const replacement = fakeTablessWatcher(async () => ({ ok: true, live: true }), "kick");
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true, idleWatchlistChannels: [] },
      },
    });
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(replacement);
    env.state.authHealth.kick = { status: "healthy" };
    env.state.sessions.kick = {
      platform: "kick",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("kick", { categoryId: "category-a" }),
      campaignId: "kick-campaign",
      rewardId: "reward",
      heartbeatChecks: 0,
    };
    env.state.sessions.kick.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.kick);

    const oldHeartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(oldWatcher.tick).toHaveBeenCalledOnce());
    env.state.sessions.kick = {
      ...env.state.sessions.kick,
      channel: { ...env.state.sessions.kick.channel!, categoryId: "category-b" },
    };
    const replacementHeartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(replacement.tick).toHaveBeenCalledOnce());

    oldResult.resolve({ ok: false, live: true, message: "obsolete category failed" });
    await Promise.all([oldHeartbeat, replacementHeartbeat]);

    expect(oldWatcher.stop).toHaveBeenCalledOnce();
    expect(replacement.start).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://kick.com/kick-creator",
        categoryId: "category-b",
      }),
      expect.any(Object),
    );
    expect(env.state.sessions.kick).toMatchObject({
      channel: expect.objectContaining({ categoryId: "category-b" }),
      heartbeatChecks: 0,
      lastHeartbeatOk: true,
      tablessHeartbeat: expect.objectContaining({ generation: 2 }),
    });
    expect(lastAggregateDiagnostic(env, "kick")).toContain("staleResult=true");
  });

  it("completes a due heartbeat while unchanged-target scheduler persistence is blocked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const { env, watcher } = await establishedTablessEnv("twitch");
    const schedulerSaveStarted = deferred<void>();
    const allowSchedulerSave = deferred<void>();
    const persist = env.deps.saveState.getMockImplementation()!;
    let blockNextSave = false;
    env.deps.applyAdFocus.mockImplementation(async () => {
      blockNextSave = true;
    });
    env.deps.saveState.mockImplementation(async (next) => {
      if (blockNextSave) {
        blockNextSave = false;
        schedulerSaveStarted.resolve();
        await allowSchedulerSave.promise;
      }
      await persist(next);
    });
    let transportCompleted = false;
    watcher.tick.mockClear();
    watcher.tick.mockImplementation(async () => {
      transportCompleted = true;
      return { ok: true, live: true };
    });

    const schedulerTick = env.controller.tick(["twitch"]);
    await schedulerSaveStarted.promise;
    const heartbeat = env.controller.runWatchHeartbeat();
    try {
      await drainMicrotasks();
      expect(watcher.tick).toHaveBeenCalledOnce();
      expect(transportCompleted).toBe(true);
    } finally {
      allowSchedulerSave.resolve();
      await Promise.all([schedulerTick, heartbeat]);
    }

    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
  });

  it("persists discovery after a due heartbeat invalidates a blocked snapshot selection", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const selectionStarted = deferred<void>();
    const allowSelection = deferred<void>();
    let blockSelection = false;
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
      },
    }, {
      selectWatchTarget: async (...args) => {
        if (blockSelection) {
          selectionStarted.resolve();
          await allowSelection.promise;
        }
        return selectWatchTargetFromSnapshot(...args);
      },
    });
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    env.twitch.supportsTabless = true;
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    await env.controller.tick(["twitch"]);
    const firstCheckedAt = env.state.sessions.twitch.lastCheckedAt;
    expect(firstCheckedAt).toBeDefined();
    advanceToNextHeartbeatDue();
    watcher.tick.mockClear();

    blockSelection = true;
    const selection = env.controller.tick(["twitch"], "manual_tick");
    await selectionStarted.promise;
    const heartbeat = env.controller.runWatchHeartbeat();
    try {
      await drainMicrotasks();
      expect(watcher.tick).toHaveBeenCalledOnce();
      await heartbeat;
    } finally {
      allowSelection.resolve();
      await selection;
    }
    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    expect(Date.parse(env.state.sessions.twitch.lastCheckedAt ?? "")).toBeGreaterThan(
      Date.parse(firstCheckedAt ?? ""),
    );
  });

  it("persists discovery lastCheckedAt when a heartbeat commits during publication", async () => {
    const { env, watcher } = await establishedTablessEnv("twitch");
    const firstCheckedAt = env.state.sessions.twitch.lastCheckedAt;
    expect(firstCheckedAt).toBeDefined();
    const focusStarted = deferred<void>();
    const allowFocus = deferred<void>();
    env.deps.applyAdFocus.mockImplementation(async () => {
      focusStarted.resolve();
      await allowFocus.promise;
    });
    watcher.tick.mockClear();

    const discovery = env.controller.tick(["twitch"]);
    await focusStarted.promise;
    await env.controller.runWatchHeartbeat();
    allowFocus.resolve();
    await discovery;

    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    expect(Date.parse(env.state.sessions.twitch.lastCheckedAt ?? "")).toBeGreaterThan(
      Date.parse(firstCheckedAt ?? ""),
    );
  });

  it("persists discovery when a heartbeat commits before the scheduler consumes its selection", async () => {
    const { env, watcher } = await establishedTablessEnv("twitch");
    const firstCheckedAt = env.state.sessions.twitch.lastCheckedAt;
    expect(firstCheckedAt).toBeDefined();
    const claimStarted = deferred<void>();
    const allowClaim = deferred<boolean>();
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([
      { ...campaign("twitch", "claimable"), id: "claimable-campaign" },
      campaign("twitch"),
    ]);
    vi.mocked(env.twitch.claimReward).mockImplementation(async () => {
      claimStarted.resolve();
      return allowClaim.promise;
    });
    watcher.tick.mockClear();

    const discovery = env.controller.tick(["twitch"], "manual_tick");
    await claimStarted.promise;
    await env.controller.runWatchHeartbeat();
    allowClaim.resolve(false);
    await discovery;

    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    expect(Date.parse(env.state.sessions.twitch.lastCheckedAt ?? "")).toBeGreaterThan(
      Date.parse(firstCheckedAt ?? ""),
    );
  });

  describe("platform-local route reporting", () => {
    it.each([
      ["auth", "discovery"],
      ["tick", "discovery"],
      ["auth", "heartbeat"],
      ["tick", "heartbeat"],
    ] as const)("does not let a stalled Kick %s summary block Twitch %s", async (kickOperation, twitchOperation) => {
      const summaryStarted = deferred<void>();
      const releaseSummary = deferred<void>();
      const env = harness(farming({ ...DEFAULT_SETTINGS, tablessMode: true }), {
        reportEvents: async (events) => {
          if (events.some((event) => event.platform === "kick" && event.category === "diagnostic" && event.code === "kick_fetch_summary")) {
            summaryStarted.resolve();
            await releaseSummary.promise;
          }
        },
      });
      let providerRequests = 0;
      const watcher = fakeTablessWatcher(async () => {
        providerRequests += 1;
        return { ok: true, live: true };
      });
      env.twitch.supportsTabless = true;
      env.twitch.createTablessWatcher = () => watcher;
      env.deps.createAdapter.mockImplementation((platform, emit, settings) => ({
        adapter: platform === "kick" ? kickAdapter(createKickFetcher({
          background: async (url) => url.endsWith("/user") ? { id: 42 } : { data: [] },
        }), undefined, undefined, emit) : env.twitch,
        ...resolveCompatibility(settings.compatibility, { host: "extension", twitchIdentity: "web" }),
      }));
      if (twitchOperation === "heartbeat") {
        await env.controller.tick(["twitch"]);
        advanceToNextHeartbeatDue();
      }
      let kickCompleted = false;
      const kickWork = (kickOperation === "auth"
        ? env.controller.checkAuthHealth("kick")
        : env.controller.tick(["kick"])).then(() => { kickCompleted = true; });
      await summaryStarted.promise;
      let twitchCompleted = false;
      const twitchWork = (twitchOperation === "discovery"
        ? env.controller.tick(["twitch"])
        : env.controller.runWatchHeartbeat()).then(() => { twitchCompleted = true; });
      let reportsSettled = false;
      const settling = env.controller.settleBackgroundWork().then(() => { reportsSettled = true; });
      try {
        await drainMicrotasks();
        if (twitchOperation === "discovery") {
          expect(env.state.campaigns.twitch.map((item) => item.id)).toEqual(["twitch-campaign"]);
          expect(env.state.sessions.twitch.watchMode).toBe("tabless");
        } else {
          expect(providerRequests).toBe(1);
          expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
        }
        expect(twitchCompleted).toBe(true);
        expect(kickCompleted).toBe(false);
        expect(reportsSettled).toBe(false);
      } finally {
        releaseSummary.resolve();
        await Promise.all([kickWork, twitchWork, settling]);
        await env.controller.settleBackgroundWork();
        env.controller.shutdown();
      }
    });
  });

  it("correlates watcher startup route transitions and summary with the current scheduler tick", async () => {
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
      },
    });
    const watcher = new KickWatcher({
      fetcher: createKickFetcher({
        background: async (url) => {
          if (url === "https://kick.com/api/v2/channels/kick-creator") {
            return { id: 42, livestream: { id: 84, is_live: true } };
          }
          if (url === "https://websockets.kick.com/viewer/v1/token") return { data: { token: "viewer-token" } };
          throw new Error("Unexpected watcher request");
        },
      }),
      createWebSocket: () => ({ readyState: 0, send() {}, close() {}, addEventListener() {} }),
    });
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = () => watcher;
    try {
      await env.controller.tick(["twitch"]);
      await env.controller.tick(["kick"]);

      expect(env.state.sessions.kick.watchMode).toBe("tabless");
      const routes = allDiagnostics(env).filter((event) => event.code === "kick_fetch_route");
      const summaries = allDiagnostics(env).filter((event) => event.code === "kick_fetch_summary");
      expect(routes).toHaveLength(2);
      expect(summaries.map((event) => event.data)).toEqual([{ "kick.com.background": 1, "websockets.kick.com.background": 1 }]);
      for (const event of [...routes, ...summaries]) {
        expect(event).toMatchObject({ platformTickId: 1, globalTickId: 2 });
      }
    } finally {
      await watcher.stop();
      env.controller.shutdown();
    }
  });

  it("completes a due initial heartbeat while discovery-signal start is blocked after publication", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const observerStartReached = deferred<void>();
    const allowObserverStart = deferred<void>();
    let transportCompleted = false;
    const watcher = fakeTablessWatcher(async () => {
      transportCompleted = true;
      return { ok: true, live: true };
    }, "kick");
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true, idleWatchlistChannels: [] },
      },
    });
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = vi.fn(() => watcher);
    const startObserver = env.discoverySignalController.start.bind(env.discoverySignalController);
    vi.spyOn(env.discoverySignalController, "start").mockImplementation(async (target, onSignal) => {
      await startObserver(target, onSignal);
      observerStartReached.resolve();
      await allowObserverStart.promise;
    });

    const schedulerTick = env.controller.tick(["kick"]);
    await observerStartReached.promise;
    expect(watcher.start).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
    const heartbeat = env.controller.runWatchHeartbeat();
    try {
      await drainMicrotasks();
      expect(watcher.tick).toHaveBeenCalledOnce();
      expect(transportCompleted).toBe(true);
    } finally {
      allowObserverStart.resolve();
      await Promise.all([schedulerTick, heartbeat]);
    }

    expect(env.kick.createTablessWatcher).toHaveBeenCalledOnce();
    expect(env.state.sessions.kick.lastHeartbeatOk).toBe(true);
  });

  it("publishes a successor before an old heartbeat result can block the handoff", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const oldResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
    const allowSuccessorStart = deferred<void>();
    const allowOldResultSave = deferred<void>();
    const oldWatcher = fakeTablessWatcher(() => oldResult.promise);
    const successorWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    successorWatcher.start.mockImplementation(async (candidate) => {
      await allowSuccessorStart.promise;
      successorWatcher.channelUrl = candidate.url;
    });
    const successorChannel = channel("twitch", {
      username: "unpublished-successor",
      url: "https://www.twitch.tv/unpublished-successor",
      broadcastId: "unpublished-successor-broadcast",
    });
    const successorCampaign: DropCampaign = {
      ...campaign("twitch"),
      id: "unpublished-successor-campaign",
      rewards: [{ ...reward(), id: "unpublished-successor-reward" }],
    };
    const env = tablessEnv();
    env.twitch.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(successorWatcher);
    await env.controller.tick(["twitch"]);
    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));

    const oldHeartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(oldWatcher.tick).toHaveBeenCalledOnce());
    const persist = env.deps.saveState.getMockImplementation()!;
    let oldResultSaveBlocked = false;
    env.deps.saveState.mockImplementation(async (next) => {
      if (
        next.sessions.twitch.campaignId === "twitch-campaign"
        && next.sessions.twitch.lastHeartbeatAt !== undefined
      ) {
        oldResultSaveBlocked = true;
        await allowOldResultSave.promise;
      }
      await persist(next);
    });
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([successorCampaign]);
    vi.mocked(env.twitch.listCandidateChannels).mockResolvedValue([successorChannel]);

    const successorTick = env.controller.tick(["twitch"]);
    await vi.waitFor(() => expect(successorWatcher.start).toHaveBeenCalledOnce());
    oldResult.resolve({ ok: true, live: true });
    await drainMicrotasks();
    allowSuccessorStart.resolve();
    try {
      await drainMicrotasks();
      expect(oldWatcher.stop).toHaveBeenCalledOnce();
      expect(oldResultSaveBlocked).toBe(false);
    } finally {
      allowOldResultSave.resolve();
      await Promise.all([successorTick, oldHeartbeat]);
    }

    expect(env.state.sessions.twitch).toMatchObject({
      campaignId: "unpublished-successor-campaign",
      rewardId: "unpublished-successor-reward",
      tablessHeartbeat: expect.objectContaining({ generation: 2 }),
    });
    expect(env.state.sessions.twitch.lastHeartbeatAt).toBeUndefined();
    expect(lastAggregateDiagnostic(env, "twitch")).toContain("staleResult=true");
  });

  it("rejects an old heartbeat while a successor lane waits to save scheduler state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const oldResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
    const allowSuccessorSave = deferred<void>();
    const oldWatcher = fakeTablessWatcher(() => oldResult.promise);
    oldWatcher.stop.mockImplementation(async () => {
      await allowSuccessorSave.promise;
      oldWatcher.channelUrl = undefined;
    });
    const successorWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const successorChannel = channel("twitch", {
      username: "successor-creator",
      url: "https://www.twitch.tv/successor-creator",
      broadcastId: "successor-broadcast",
    });
    const successorCampaign: DropCampaign = {
      ...campaign("twitch"),
      id: "successor-campaign",
      rewards: [{ ...reward(), id: "successor-reward" }],
    };
    const env = tablessEnv({ tablessFallbackFailureLimit: 1 });
    env.twitch.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(successorWatcher);
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch", { broadcastId: "old-broadcast" }),
      campaignId: "old-campaign",
      rewardId: "old-reward",
      heartbeatChecks: 0,
    };
    env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.twitch);

    const oldHeartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(oldWatcher.tick).toHaveBeenCalledOnce());
    env.reportEvents.mockClear();
    env.deps.saveState.mockClear();
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([successorCampaign]);
    vi.mocked(env.twitch.listCandidateChannels).mockResolvedValue([successorChannel]);

    const successorTick = env.controller.tick(["twitch"]);
    // Displaced-watcher cleanup starts only after commitHeartbeatContext has
    // published the complete successor, and scheduler persistence follows it.
    await vi.waitFor(() => expect(oldWatcher.stop).toHaveBeenCalledOnce());
    expect(successorWatcher.start).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "successor-creator",
        broadcastId: "successor-broadcast",
      }),
      expect.any(Object),
    );
    const savesBeforeOldResult = env.deps.saveState.mock.calls.length;

    try {
      oldResult.resolve({
        ok: false,
        live: true,
        message: "obsolete lane heartbeat failed",
      });
      await oldHeartbeat;

      expect(env.state.sessions.twitch).toMatchObject({
        channel: expect.objectContaining({ broadcastId: "old-broadcast" }),
        campaignId: "old-campaign",
        rewardId: "old-reward",
        heartbeatChecks: 0,
      });
      expect(env.state.sessions.twitch.lastHeartbeatAt).toBeUndefined();
      expect(env.state.sessions.twitch.lastHeartbeatOk).toBeUndefined();
      expect(env.state.sessions.twitch.tablessHeartbeat).toEqual({
        generation: 1,
        contextKey: "[\"twitch\",\"https://www.twitch.tv/twitch-creator\",\"twitch-creator\",\"old-broadcast\",\"\",\"\",\"old-campaign\",\"old-reward\"]",
        nextDueAt: "2026-09-02T12:00:00.000Z",
      });
      expect(env.deps.saveState).toHaveBeenCalledTimes(savesBeforeOldResult);
      expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
      const diagnostics = allDiagnostics(env).map((event) => event.message);
      expect(diagnostics).not.toContain("obsolete lane heartbeat failed");
      expect(diagnostics).not.toContain(
        "Tabless watch heartbeat keeps failing; falling back to a watch tab",
      );
      expect(env.reportEvents.mock.calls
        .flatMap(([events]) => events)
        .filter((event) => event.category === "activity")).toEqual([]);
      expect(aggregateHeartbeatDiagnostics(env, "twitch")).toHaveLength(1);
      expect(lastAggregateDiagnostic(env, "twitch")).toContain("outcome=failed");
      expect(lastAggregateDiagnostic(env, "twitch")).toContain("staleResult=true");
    } finally {
      allowSuccessorSave.resolve();
      await successorTick;
    }

    expect(env.state.sessions.twitch).toMatchObject({
      channel: expect.objectContaining({
        username: "successor-creator",
        broadcastId: "successor-broadcast",
      }),
      campaignId: "successor-campaign",
      rewardId: "successor-reward",
      heartbeatChecks: 0,
    });
    expect(env.state.sessions.twitch.lastHeartbeatAt).toBeUndefined();
    expect(env.state.sessions.twitch.lastHeartbeatOk).toBeUndefined();
  });

  it("keeps a scheduler target switch authoritative while its watcher start is blocked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const allowSuccessorStart = deferred<void>();
    const oldWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const successorWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    successorWatcher.start.mockImplementation(async (candidate) => {
      await allowSuccessorStart.promise;
      successorWatcher.channelUrl = candidate.url;
    });
    const successorChannel = channel("twitch", {
      username: "lease-successor",
      url: "https://www.twitch.tv/lease-successor",
      broadcastId: "lease-successor-broadcast",
    });
    const successorCampaign: DropCampaign = {
      ...campaign("twitch"),
      id: "lease-successor-campaign",
      rewards: [{ ...reward(), id: "lease-successor-reward" }],
    };
    const env = tablessEnv();
    env.twitch.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(successorWatcher);
    await env.controller.tick(["twitch"]);
    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([successorCampaign]);
    vi.mocked(env.twitch.listCandidateChannels).mockResolvedValue([successorChannel]);

    const successorTick = env.controller.tick(["twitch"]);
    await vi.waitFor(() => expect(successorWatcher.start).toHaveBeenCalledOnce());
    const alarm = env.controller.runWatchHeartbeat();
    try {
      await drainMicrotasks();
      expect(oldWatcher.tick).not.toHaveBeenCalled();
    } finally {
      allowSuccessorStart.resolve();
      await Promise.all([successorTick, alarm]);
    }

    expect(oldWatcher.stop).toHaveBeenCalledOnce();
    expect(successorWatcher.stop).not.toHaveBeenCalled();
    expect(env.state.sessions.twitch).toMatchObject({
      channel: expect.objectContaining({ username: "lease-successor" }),
      campaignId: "lease-successor-campaign",
      rewardId: "lease-successor-reward",
      tablessHeartbeat: expect.objectContaining({ generation: 2 }),
    });
    // The blocked-start wait uses Vitest's polling clock, so the new anchor can
    // be a few fake milliseconds after 12:02:00. Advance past that slot.
    vi.setSystemTime(new Date("2026-09-02T12:03:00.000Z"));
    await env.controller.runWatchHeartbeat();
    expect(oldWatcher.tick).not.toHaveBeenCalled();
    expect(successorWatcher.tick).toHaveBeenCalledOnce();
  });

  it("keeps an initial published watcher authoritative until scheduler persistence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const allowSchedulerSave = deferred<void>();
    const schedulerSaveStarted = deferred<void>();
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const obsoleteRecovery = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv({ postClaimHandoff: true });
    env.twitch.supportsPostClaimHandoff = true;
    env.twitch.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(watcher)
      .mockReturnValueOnce(obsoleteRecovery);
    const persist = env.deps.saveState.getMockImplementation()!;
    env.deps.saveState.mockImplementation(async (next) => {
      if (
        next.sessions.twitch.status === "watching"
        && next.sessions.twitch.tablessHeartbeat !== undefined
      ) {
        schedulerSaveStarted.resolve();
        await allowSchedulerSave.promise;
      }
      await persist(next);
    });

    const schedulerTick = env.controller.tick(["twitch"]);
    await schedulerSaveStarted.promise;
    expect(watcher.start).toHaveBeenCalledOnce();
    const alarm = env.controller.runWatchHeartbeat();
    try {
      await drainMicrotasks();
      expect(watcher.stop).not.toHaveBeenCalled();
      expect(obsoleteRecovery.start).not.toHaveBeenCalled();
    } finally {
      allowSchedulerSave.resolve();
      await Promise.all([schedulerTick, alarm]);
    }

    expect(watcher.tick).not.toHaveBeenCalled();
    expect(watcher.stop).not.toHaveBeenCalled();
    expect(obsoleteRecovery.start).not.toHaveBeenCalled();
    expect(env.twitch.createTablessWatcher).toHaveBeenCalledOnce();

    await env.controller.runClaimHandoff("twitch");
    expect(watcher.tick).toHaveBeenCalledOnce();
    expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt)
      .toBe("2026-09-02T12:01:00.000Z");

    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
    await env.controller.runWatchHeartbeat();
    expect(watcher.tick).toHaveBeenCalledTimes(2);
  });

  it("keeps the published successor authoritative while its scheduler save is pending", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const allowSuccessorSave = deferred<void>();
    const successorSaveStarted = deferred<void>();
    const oldWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const successorWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const obsoleteRecovery = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const successorChannel = channel("twitch", {
      username: "successor-creator",
      url: "https://www.twitch.tv/successor-creator",
      broadcastId: "successor-broadcast",
    });
    const successorCampaign: DropCampaign = {
      ...campaign("twitch"),
      id: "successor-campaign",
      rewards: [{ ...reward(), id: "successor-reward" }],
    };
    const env = tablessEnv({ postClaimHandoff: true });
    env.twitch.supportsPostClaimHandoff = true;
    env.twitch.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(successorWatcher)
      .mockReturnValueOnce(obsoleteRecovery);
    await env.controller.tick(["twitch"]);
    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
    vi.mocked(env.twitch.refreshCampaigns).mockResolvedValue([successorCampaign]);
    vi.mocked(env.twitch.listCandidateChannels).mockResolvedValue([successorChannel]);
    const persist = env.deps.saveState.getMockImplementation()!;
    env.deps.saveState.mockImplementation(async (next) => {
      if (next.sessions.twitch.rewardId === "successor-reward") {
        successorSaveStarted.resolve();
        await allowSuccessorSave.promise;
      }
      await persist(next);
    });

    const successorTick = env.controller.tick(["twitch"]);
    await successorSaveStarted.promise;
    expect(successorWatcher.start).toHaveBeenCalledOnce();
    // The lane now owns generation 2, while loadState still returns the old
    // generation-1 session until the blocked scheduler save completes.
    const alarm = env.controller.runWatchHeartbeat();
    await drainMicrotasks();
    allowSuccessorSave.resolve();
    await Promise.all([successorTick, alarm]);

    expect(successorWatcher.stop).not.toHaveBeenCalled();
    expect(obsoleteRecovery.start).not.toHaveBeenCalled();
    expect(obsoleteRecovery.tick).not.toHaveBeenCalled();
    expect(env.twitch.createTablessWatcher).toHaveBeenCalledTimes(2);

    await env.controller.runClaimHandoff("twitch", ["reward"]);

    expect(successorWatcher.tick).toHaveBeenCalledOnce();
    expect(env.state.sessions.twitch).toMatchObject({
      campaignId: "successor-campaign",
      rewardId: "successor-reward",
      lastHeartbeatOk: true,
      tablessHeartbeat: expect.objectContaining({ generation: 2 }),
    });
  });

  it("advances generation when the same context is recreated after detachment", async () => {
    const oldResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
    const oldWatcher = fakeTablessWatcher(() => oldResult.promise);
    const replacement = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv({ tablessFallbackFailureLimit: 1 });
    env.twitch.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(replacement);
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch", { broadcastId: "same-broadcast" }),
      campaignId: "same-campaign",
      rewardId: "same-reward",
      heartbeatChecks: 0,
    };
    env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.twitch);

    const oldHeartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(oldWatcher.tick).toHaveBeenCalledOnce());
    env.state.authHealth.twitch = {
      status: "invalid_credentials",
      checkedAt: "2026-09-02T12:00:01.000Z",
      reasonCode: "credentials_rejected",
      message: { key: "authInvalidCredentials" },
    };
    await env.controller.runWatchHeartbeat();
    expect(oldWatcher.stop).toHaveBeenCalledOnce();

    env.state.authHealth.twitch = { status: "healthy" };
    const replacementHeartbeat = env.controller.runWatchHeartbeat();
    try {
      await drainMicrotasks();
      expect(replacement.tick).toHaveBeenCalledOnce();
    } finally {
      oldResult.resolve({ ok: false, live: true, message: "obsolete recreation failed" });
      await Promise.all([oldHeartbeat, replacementHeartbeat]);
    }

    expect(env.state.sessions.twitch).toMatchObject({
      lastHeartbeatOk: true,
      heartbeatChecks: 0,
      tablessHeartbeat: expect.objectContaining({ generation: 2 }),
    });
    expect(lastAggregateDiagnostic(env, "twitch")).toContain("staleResult=true");
  });

  it("serializes service-worker restart recovery without letting a slow old target win", async () => {
    const slowStart = deferred<void>();
    const oldWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    oldWatcher.start.mockImplementation(async (candidate) => {
      await slowStart.promise;
      oldWatcher.channelUrl = candidate.url;
    });
    const newWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(oldWatcher)
      .mockReturnValueOnce(newWatcher);
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch", { broadcastId: "old-broadcast" }),
      campaignId: "old-campaign",
      rewardId: "old-reward",
    };
    env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.twitch);

    const oldRecovery = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(oldWatcher.start).toHaveBeenCalled());
    env.state.sessions.twitch = {
      ...env.state.sessions.twitch,
      channel: channel("twitch", {
        username: "new-creator",
        url: "https://www.twitch.tv/new-creator",
        broadcastId: "new-broadcast",
      }),
      campaignId: "new-campaign",
      rewardId: "new-reward",
      tablessHeartbeat: undefined,
    };
    env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.twitch);
    const newRecovery = env.controller.runWatchHeartbeat();
    await drainMicrotasks();
    expect(newWatcher.start).not.toHaveBeenCalled();

    slowStart.resolve();
    await Promise.all([oldRecovery, newRecovery]);

    expect(oldWatcher.stop).toHaveBeenCalledOnce();
    expect(newWatcher.stop).not.toHaveBeenCalled();
    expect(newWatcher.tick).toHaveBeenCalledOnce();
    oldWatcher.tick.mockClear();
    newWatcher.tick.mockClear();
    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();
    expect(oldWatcher.tick).not.toHaveBeenCalled();
    expect(newWatcher.tick).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent same-context service-worker restart recovery", async () => {
    const slowStart = deferred<void>();
    const slowWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }), "kick");
    slowWatcher.start.mockImplementation(async (candidate) => {
      await slowStart.promise;
      slowWatcher.channelUrl = candidate.url;
    });
    const winner = fakeTablessWatcher(async () => ({ ok: true, live: true }), "kick");
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true, idleWatchlistChannels: [] },
      },
    });
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = vi.fn()
      .mockReturnValueOnce(slowWatcher)
      .mockReturnValueOnce(winner);
    env.state.authHealth.kick = { status: "healthy" };
    env.state.sessions.kick = {
      platform: "kick",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("kick"),
      campaignId: "kick-campaign",
      rewardId: "reward",
    };
    env.state.sessions.kick.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.kick);

    const slowRecovery = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(slowWatcher.start).toHaveBeenCalled());
    const winningRecovery = env.controller.runWatchHeartbeat();
    await drainMicrotasks();
    expect(winner.start).not.toHaveBeenCalled();

    slowStart.resolve();
    await Promise.all([slowRecovery, winningRecovery]);

    expect(slowWatcher.stop).not.toHaveBeenCalled();
    expect(slowWatcher.tick).toHaveBeenCalledOnce();
    expect(winner.stop).not.toHaveBeenCalled();
    expect(winner.tick).not.toHaveBeenCalled();
    expect(env.kick.createTablessWatcher).toHaveBeenCalledOnce();
    slowWatcher.tick.mockClear();
    winner.tick.mockClear();
    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();
    expect(slowWatcher.tick).toHaveBeenCalledOnce();
    expect(winner.tick).not.toHaveBeenCalled();
  });

  it("does not let a stale non-tabless removal clear a newer committed winner", async () => {
    const winnerStart = deferred<void>();
    const winner = fakeTablessWatcher(async () => ({ ok: true, live: true }), "kick");
    winner.start.mockImplementation(async (candidate) => {
      await winnerStart.promise;
      winner.channelUrl = candidate.url;
    });
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true, idleWatchlistChannels: [] },
      },
    });
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = vi.fn(() => winner);
    const winningState = structuredClone(env.state);
    winningState.authHealth.kick = { status: "healthy" };
    winningState.sessions.kick = {
      platform: "kick",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("kick"),
      campaignId: "kick-campaign",
      rewardId: "reward",
    };
    winningState.sessions.kick.tablessHeartbeat = dueHeartbeatCadence(winningState.sessions.kick);
    const staleState = structuredClone(winningState);
    staleState.sessions.kick = {
      platform: "kick",
      status: "paused",
      offlineChecks: 0,
    };
    const staleRead = deferred<SchedulerState>();
    env.deps.loadState
      .mockResolvedValueOnce(winningState)
      .mockResolvedValueOnce(winningState)
      .mockImplementationOnce(() => staleRead.promise)
      .mockImplementationOnce(() => staleRead.promise)
      .mockResolvedValueOnce(winningState);

    const winningRecovery = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(winner.start).toHaveBeenCalled());
    const staleRemoval = env.controller.runWatchHeartbeat();
    staleRead.resolve(staleState);
    winnerStart.resolve();
    await Promise.all([winningRecovery, staleRemoval]);

    expect(winner.stop).not.toHaveBeenCalled();
    winner.tick.mockClear();
    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();
    expect(winner.tick).toHaveBeenCalledOnce();
  });

  it("does not let a stale removal revision reject a newer candidate", async () => {
    const candidate = fakeTablessWatcher(async () => ({ ok: true, live: true }), "kick");
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: false },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true, idleWatchlistChannels: [] },
      },
    });
    env.kick.supportsTabless = true;
    env.kick.createTablessWatcher = vi.fn(() => candidate);
    const candidateState = structuredClone(env.state);
    candidateState.authHealth.kick = { status: "healthy" };
    candidateState.sessions.kick = {
      platform: "kick",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("kick"),
      campaignId: "kick-campaign",
      rewardId: "reward",
    };
    candidateState.sessions.kick.tablessHeartbeat = dueHeartbeatCadence(candidateState.sessions.kick);
    const staleState = structuredClone(candidateState);
    staleState.sessions.kick = {
      platform: "kick",
      status: "paused",
      offlineChecks: 0,
    };
    const staleRead = deferred<SchedulerState>();
    const candidateRead = deferred<SchedulerState>();
    env.deps.loadState
      .mockImplementationOnce(() => staleRead.promise)
      .mockImplementationOnce(() => staleRead.promise)
      .mockImplementationOnce(() => candidateRead.promise)
      .mockImplementationOnce(() => candidateRead.promise)
      .mockResolvedValueOnce(candidateState);

    const staleRemoval = env.controller.runWatchHeartbeat();
    const winningRecovery = env.controller.runWatchHeartbeat();
    staleRead.resolve(staleState);
    candidateRead.resolve(candidateState);
    await Promise.all([staleRemoval, winningRecovery]);

    expect(candidate.stop).not.toHaveBeenCalled();
    candidate.tick.mockClear();
    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();
    expect(candidate.tick).toHaveBeenCalledOnce();
  });

  it.each(["startup", "host reset"] as const)(
    "%s atomically clears heartbeat ownership before a later heartbeat",
    async (lifecycle) => {
      const stoppedWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const replacement = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = tablessEnv({ autoStartDropFarming: true });
      env.twitch.createTablessWatcher = vi.fn()
        .mockReturnValueOnce(stoppedWatcher)
        .mockReturnValueOnce(replacement);
      await env.controller.tick(["twitch"]);
      stoppedWatcher.tick.mockClear();

      if (lifecycle === "startup") {
        await env.controller.handleStartup();
      } else {
        await env.controller.prepareForHostReset();
      }
      advanceToNextHeartbeatDue();
      await env.controller.runWatchHeartbeat();

      expect(stoppedWatcher.stop).toHaveBeenCalledOnce();
      expect(stoppedWatcher.tick).not.toHaveBeenCalled();
      expect(replacement.tick).toHaveBeenCalledOnce();
      expect(replacement.stop).not.toHaveBeenCalled();
      expect(env.twitch.createTablessWatcher).toHaveBeenCalledTimes(2);
    },
  );

  it("shutdown atomically detaches heartbeat ownership before watcher cleanup", async () => {
    const cleanup = deferred<void>();
    const { env, watcher } = await establishedTablessEnv("twitch");
    watcher.stop.mockImplementation(async () => cleanup.promise);

    env.controller.shutdown();
    await vi.waitFor(() => expect(watcher.stop).toHaveBeenCalledOnce());
    await env.controller.runWatchHeartbeat();

    expect(watcher.tick).not.toHaveBeenCalled();
    cleanup.resolve();
    await env.controller.settleBackgroundWork();
  });

  it.each(["scheduled", "immediate"] as const)(
    "does not reserve a queued %s heartbeat after shutdown wins lane admission",
    async (kind) => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = tablessEnv({ postClaimHandoff: true });
      env.twitch.supportsPostClaimHandoff = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      await env.controller.tick(["twitch"]);
      if (kind === "scheduled") advanceToNextHeartbeatDue();

      // Queue shutdown immediately before withHeartbeatLane queues its callback.
      // The request therefore entered the common path while live, but the lane
      // reservation itself must observe shutdown and avoid even reading attemptAt.
      const now = Date.now();
      let reads = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        reads += 1;
        if (reads === 1) queueMicrotask(() => env.controller.shutdown());
        return now;
      });
      try {
        if (kind === "scheduled") {
          await env.controller.runWatchHeartbeat();
        } else {
          await env.controller.runClaimHandoff("twitch", ["claimed-reward"]);
        }
      } finally {
        nowSpy.mockRestore();
        await env.controller.settleBackgroundWork();
      }

      expect(watcher.tick).not.toHaveBeenCalled();
      expect(aggregateHeartbeatDiagnostics(env, "twitch")).toEqual([]);
    },
  );

  it.each(["scheduled", "immediate"] as const)(
    "does not launch an admitted %s heartbeat when shutdown begins before transport",
    async (kind) => {
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = tablessEnv({ postClaimHandoff: true });
      env.twitch.supportsPostClaimHandoff = true;
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      await env.controller.tick(["twitch"]);
      if (kind === "scheduled") advanceToNextHeartbeatDue();

      // Date.now is read once before queueing and once while reserving. Landing
      // shutdown on the latter exercises the final pre-transport admission
      // check after the lane has already created an attempt.
      const now = Date.now();
      let reads = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        reads += 1;
        if (reads === 2) env.controller.shutdown();
        return now;
      });
      try {
        if (kind === "scheduled") {
          await env.controller.runWatchHeartbeat();
        } else {
          await env.controller.runClaimHandoff("twitch", ["claimed-reward"]);
        }
      } finally {
        nowSpy.mockRestore();
        await env.controller.settleBackgroundWork();
      }

      expect(watcher.tick).not.toHaveBeenCalled();
      expect(aggregateHeartbeatDiagnostics(env, "twitch")).toEqual([]);
    },
  );

  it("farms tablessly without opening a tab and records heartbeat health", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;

    await env.controller.tick();

    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
    expect(env.state.sessions.twitch.watchMode).toBe("tabless");
    expect(watcher.start).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://www.twitch.tv/twitch-creator" }),
      expect.any(Object),
    );

    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();

    expect(watcher.tick).toHaveBeenCalled();
    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    expect(env.state.sessions.twitch.heartbeatChecks).toBe(0);
  });

  it("lets Kick heartbeat and persist while Twitch heartbeat is still pending", async () => {
    const twitchHeartbeat = deferred<{ ok: boolean; live?: boolean; message?: string }>();
    const twitchWatcher = fakeTablessWatcher(() => twitchHeartbeat.promise, "twitch");
    const kickWatcher = fakeTablessWatcher(async () => ({ ok: true, live: true }), "kick");
    const env = harness(farming({ ...DEFAULT_SETTINGS, tablessMode: true }));
    env.twitch.supportsTabless = true;
    env.kick.supportsTabless = true;
    env.twitch.createTablessWatcher = () => twitchWatcher as unknown as TablessWatchController;
    env.kick.createTablessWatcher = () => kickWatcher as unknown as TablessWatchController;
    await env.controller.tick(["twitch"]);
    await env.controller.tick(["kick"]);

    advanceToNextHeartbeatDue();
    const heartbeat = env.controller.runWatchHeartbeat();

    try {
      await vi.waitFor(() => expect(twitchWatcher.tick).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(kickWatcher.tick).toHaveBeenCalledOnce());
      expect(env.state.sessions.kick.lastHeartbeatOk).toBe(true);
      expect(env.state.sessions.twitch.lastHeartbeatAt).toBeUndefined();
    } finally {
      twitchHeartbeat.resolve({ ok: true, live: true });
      await heartbeat;
    }

    expect(env.state.sessions.twitch.lastHeartbeatOk).toBe(true);
    expect(env.state.sessions.kick.lastHeartbeatOk).toBe(true);
  });

  it.each(["twitch", "kick"] as const)(
    "attempts a due %s heartbeat while discovery holds the platform lock",
    async (platform) => {
      const blocked = deferred<DropCampaign[]>();
      const { env, adapter, watcher } = await establishedTablessEnv(platform);
      adapter.refreshCampaigns = vi.fn(() => blocked.promise);
      const discovery = env.controller.tick([platform]);
      await vi.waitFor(() => expect(adapter.refreshCampaigns).toHaveBeenCalled());

      const heartbeat = env.controller.runWatchHeartbeat();
      try {
        await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalled());
      } finally {
        blocked.resolve([]);
        await Promise.all([discovery, heartbeat]);
      }
    },
  );

  it.each(["twitch", "kick"] as const)(
    "runs %s discovery while the platform heartbeat transport is pending",
    async (platform) => {
      const blocked = deferred<{ ok: boolean; live?: boolean; message?: string }>();
      const { env, adapter, watcher } = await establishedTablessEnv(platform);
      watcher.tick.mockImplementation(() => blocked.promise);

      const heartbeat = env.controller.runWatchHeartbeat();
      await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalled());
      const discovery = env.controller.tick([platform]);
      try {
        await vi.waitFor(() => expect(adapter.refreshCampaigns).toHaveBeenCalledTimes(2));
      } finally {
        blocked.resolve({ ok: true, live: true });
        await Promise.all([heartbeat, discovery]);
      }
    },
  );

  it("merge-safely persists page-context lifecycle metadata changed during a heartbeat", async () => {
    const heartbeatResult = deferred<{ ok: boolean; live?: boolean; message?: string }>();
    const watcher = fakeTablessWatcher(async () => {
      recordManagedPageContextFallback("twitch", "gql.twitch.tv", undefined, Date.parse("2026-07-21T12:00:00.000Z"));
      return heartbeatResult.promise;
    });
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    await env.controller.tick();
    const context = {
      platform: "twitch" as const,
      tabId: 66,
      originUrl: "https://www.twitch.tv/drops/inventory",
      origin: "https://www.twitch.tv",
      ownedByExtension: true as const,
    };
    env.state.managedPageContextTabs = { twitch: context };
    registerManagedPageContextTabs({ twitch: context });

    advanceToNextHeartbeatDue();
    const heartbeat = env.controller.runWatchHeartbeat();
    await vi.waitFor(() => expect(watcher.tick).toHaveBeenCalledOnce());
    env.state.sessions.twitch.offlineChecks = 3;
    heartbeatResult.resolve({ ok: true, live: true });
    await heartbeat;

    expect(env.state.sessions.twitch.offlineChecks).toBe(3);
    expect(env.state.managedPageContextTabs?.twitch).toMatchObject({
      tabId: 66,
      fallbackHost: "gql.twitch.tv",
      backgroundSuccesses: 0,
      lastFallbackAt: "2026-07-21T12:00:00.000Z",
    });
  });

  it("retains a heartbeat page-context update when a completed scheduler snapshot persists later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const allowScheduler = deferred<void>();
    const schedulerReachedPostTickWork = deferred<void>();
    const baseContext = {
      platform: "twitch" as const,
      tabId: 66,
      originUrl: "https://www.twitch.tv/drops/inventory",
      origin: "https://www.twitch.tv",
      ownedByExtension: true as const,
    };
    const watcher = fakeTablessWatcher(async () => {
      recordManagedPageContextFallback(
        "twitch",
        "gql.twitch.tv",
        undefined,
        Date.parse("2026-09-02T12:01:00.000Z"),
      );
      return { ok: true, live: true };
    });
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    env.state.managedPageContextTabs = { twitch: baseContext };
    registerManagedPageContextTabs({ twitch: baseContext });
    await env.controller.tick(["twitch"]);
    env.deps.applyAdFocus.mockImplementation(async () => {
      schedulerReachedPostTickWork.resolve();
      await allowScheduler.promise;
    });
    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));

    const schedulerTick = env.controller.tick(["twitch"]);
    await schedulerReachedPostTickWork.promise;
    await env.controller.runWatchHeartbeat();
    expect(env.state.managedPageContextTabs?.twitch).toMatchObject({
      fallbackHost: "gql.twitch.tv",
      backgroundSuccesses: 0,
      lastFallbackAt: "2026-09-02T12:01:00.000Z",
    });

    allowScheduler.resolve();
    await schedulerTick;

    expect(env.state.managedPageContextTabs?.twitch).toMatchObject({
      fallbackHost: "gql.twitch.tv",
      backgroundSuccesses: 0,
      lastFallbackAt: "2026-09-02T12:01:00.000Z",
    });
    registerManagedPageContextTabs({});
  });

  it("retains a current heartbeat when a stale scheduler snapshot persists the same target", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const blockedDiscovery = deferred<DropCampaign[]>();
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    await env.controller.tick(["twitch"]);

    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
    env.twitch.refreshCampaigns = vi.fn(() => blockedDiscovery.promise);
    const schedulerTick = env.controller.tick(["twitch"]);
    await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());

    vi.setSystemTime(new Date("2026-09-02T12:01:00.000Z"));
    await env.controller.runWatchHeartbeat();
    expect(env.state.sessions.twitch).toMatchObject({
      heartbeatChecks: 0,
      lastHeartbeatAt: "2026-09-02T12:01:00.000Z",
      lastHeartbeatOk: true,
      tablessHeartbeat: {
        generation: 1,
        contextKey: "[\"twitch\",\"https://www.twitch.tv/twitch-creator\",\"twitch-creator\",\"\",\"\",\"\",\"twitch-campaign\",\"reward\"]",
        nextDueAt: "2026-09-02T12:02:00.000Z",
      },
    });

    blockedDiscovery.resolve([campaign("twitch")]);
    await schedulerTick;

    expect(env.state.sessions.twitch).toMatchObject({
      heartbeatChecks: 0,
      lastHeartbeatAt: "2026-09-02T12:01:00.000Z",
      lastHeartbeatOk: true,
      tablessHeartbeat: {
        generation: 1,
        contextKey: "[\"twitch\",\"https://www.twitch.tv/twitch-creator\",\"twitch-creator\",\"\",\"\",\"\",\"twitch-campaign\",\"reward\"]",
        nextDueAt: "2026-09-02T12:02:00.000Z",
      },
    });
  });

  it("records the first current-generation failure before heartbeat fallback", async () => {
    const watcher = fakeTablessWatcher(async () => ({
      ok: false,
      live: true,
      message: "heartbeat transport rejected",
    }));
    const env = tablessEnv({ tablessFallbackFailureLimit: 2 });
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    await env.controller.tick();
    env.reportEvents.mockClear();

    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();

    expect(env.state.sessions.twitch).toMatchObject({
      lastHeartbeatOk: false,
      heartbeatChecks: 1,
    });
    expect(allDiagnostics(env).filter((event) =>
      event.message === "heartbeat transport rejected")).toHaveLength(1);
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
  });

  it("reports heartbeat recovered for a current-generation result", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
      heartbeatChecks: 1,
      lastHeartbeatAt: "2026-09-02T11:59:00.000Z",
      lastHeartbeatOk: false,
    };
    env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(env.state.sessions.twitch);

    await env.controller.runWatchHeartbeat();

    expect(env.state.sessions.twitch).toMatchObject({
      lastHeartbeatOk: true,
      heartbeatChecks: 0,
    });
    expect(allDiagnostics(env).filter((event) =>
      event.message === "Tabless watch heartbeat recovered")).toHaveLength(1);
  });

  it("publishes persistent watcher diagnostics once through the current operation batch", async () => {
    const reported: EngineEvent[][] = [];
    const env = harness({
      ...DEFAULT_SETTINGS,
      tablessMode: true,
      platform: {
        ...DEFAULT_SETTINGS.platform,
        twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
        kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
      },
    }, {
      reportEvents: async (events) => { reported.push([...events]); },
    });
    const pending: DiagnosticEvent[] = [];
    const watcher = fakeTablessWatcher(async () => {
      pending.push({ category: "diagnostic", platform: "twitch", level: "debug", message: "heartbeat-detail" });
      return { ok: true, live: true };
    });
    watcher.drainEvents.mockImplementation(() => pending.splice(0));
    env.twitch.supportsTabless = true;
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;

    await env.controller.tick();
    pending.push({ category: "diagnostic", platform: "twitch", level: "info", message: "connected-after-start" });
    expect(reported.flat().some((event) => event.category === "diagnostic" && event.message === "connected-after-start")).toBe(false);

    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat();
    expect(reported.flat().filter((event) =>
      event.category === "diagnostic"
      && (event.message === "connected-after-start" || event.message === "heartbeat-detail"))
    ).toEqual([
      expect.objectContaining({ message: "connected-after-start" }),
      expect.objectContaining({ message: "heartbeat-detail" }),
    ]);

    await env.controller.runWatchHeartbeat();
    expect(reported.flat().filter((event) => event.category === "diagnostic" && event.message === "connected-after-start")).toHaveLength(1);
  });

  it("starts heartbeat fallback at the configured failure limit", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: false, live: true }));
    const env = tablessEnv({ offlineRetryLimit: 1, tablessFallbackFailureLimit: 2 });
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;

    await env.controller.tick();
    expect(env.state.sessions.twitch.watchMode).toBe("tabless");

    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat(); // heartbeatChecks -> 1
    expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();

    advanceToNextHeartbeatDue();
    await env.controller.runWatchHeartbeat(); // heartbeatChecks -> 2, triggers fallback

    expect(env.twitch.prepareWatchTab).toHaveBeenCalled();
    expect(env.state.sessions.twitch.watchMode).toBe("tab");
    expect(env.state.sessions.twitch.tablessFallback).toBe(true);
    expect(watcher.stop).toHaveBeenCalled();
  });

  it.each(["generation", "context"] as const)(
    "skips heartbeat fallback when the persisted $authority changes after result commit",
    async (authority) => {
      let env!: ReturnType<typeof harness>;
      let replaceAuthorityAfterCommit = false;
      env = tablessEnv({ tablessFallbackFailureLimit: 1 });
      env.twitch.createTablessWatcher = () => fakeTablessWatcher(
        async () => ({ ok: false, live: true }),
      ) as unknown as TablessWatchController;
      const reportEvents = env.deps.reportEvents.getMockImplementation()!;
      env.deps.reportEvents.mockImplementation(async (events) => {
        await reportEvents(events);
        if (
          replaceAuthorityAfterCommit
          && events.some((event) =>
            event.category === "diagnostic"
            && event.message.startsWith("Tabless heartbeat timing "))
        ) {
          replaceAuthorityAfterCommit = false;
          const current = env.state.sessions.twitch;
          const nextSession: WatchSession = authority === "generation"
            ? {
                ...current,
                tablessHeartbeat: {
                  ...current.tablessHeartbeat!,
                  generation: current.tablessHeartbeat!.generation + 1,
                },
              }
            : {
                ...current,
                campaignId: "replacement-campaign",
                rewardId: "replacement-reward",
              };
          if (authority === "context") {
            nextSession.tablessHeartbeat = {
              ...current.tablessHeartbeat!,
              contextKey: heartbeatContextKey(nextSession)!,
            };
          }
          env.state.sessions.twitch = nextSession;
        }
      });
      await env.controller.tick();
      vi.mocked(env.twitch.refreshCampaigns).mockClear();
      vi.mocked(env.twitch.prepareWatchTab).mockClear();
      replaceAuthorityAfterCommit = true;

      advanceToNextHeartbeatDue();
      await env.controller.runWatchHeartbeat();

      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.twitch.prepareWatchTab).not.toHaveBeenCalled();
      expect(env.state.sessions.twitch.tablessHeartbeat).toMatchObject(
        authority === "generation"
          ? { generation: 2 }
          : { contextKey: expect.stringContaining("replacement-campaign") },
      );
    },
  );

  it("keeps successful scheduler state when stopping a tabless watcher fails", async () => {
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    await env.controller.tick();
    watcher.stop.mockRejectedValue(new Error("watcher stop failed"));

    await expect(env.controller.handleMessage({ type: "setAutomation", platform: "twitch", enabled: false })).resolves.toBeDefined();

    expect(env.state.sessions.twitch.status).toBe("paused");
    expect(env.reportEvents.mock.calls.flatMap(([events]) => events)).toContainEqual(expect.objectContaining({
      category: "diagnostic",
      platform: "twitch",
      level: "warn",
      message: "watcher stop failed",
    }));
  });

  it.each(["twitch", "kick"] as const)(
    "rebuilds the %s watcher from its normalized session after a service-worker restart without discovery",
    async (platform) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }), platform);
      const env = harness({
        ...DEFAULT_SETTINGS,
        tablessMode: true,
        platform: {
          ...DEFAULT_SETTINGS.platform,
          twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: platform === "twitch" },
          kick: {
            ...DEFAULT_SETTINGS.platform.kick,
            enabled: platform === "kick",
            idleWatchlistChannels: [],
          },
        },
      });
      const adapter = platform === "twitch" ? env.twitch : env.kick;
      adapter.supportsTabless = true;
      adapter.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      env.state.authHealth[platform] = { status: "healthy" };
      env.state.sessions[platform] = {
        platform,
        status: "watching",
        offlineChecks: 0,
        watchMode: "tabless",
        channel: channel(platform),
        campaignId: `${platform}-campaign`,
        rewardId: "reward",
      };
      env.state.sessions[platform].tablessHeartbeat = dueHeartbeatCadence(
        env.state.sessions[platform],
      );
      vi.mocked(adapter.refreshCampaigns).mockClear();
      env.discoverySignalFactory.mockClear();

      await env.controller.runWatchHeartbeat();

      expect(watcher.start).toHaveBeenCalledOnce();
      expect(watcher.tick).toHaveBeenCalledOnce();
      expect(env.state.sessions[platform]).toMatchObject({
        lastHeartbeatOk: true,
        heartbeatChecks: 0,
      });
      expect(adapter.refreshCampaigns).not.toHaveBeenCalled();
      expect(env.discoverySignalFactory).not.toHaveBeenCalled();
    },
  );

  it("treats a missing persisted cadence as immediately due after a service-worker restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
    };
    env.deps.loadState.mockImplementation(async () => structuredClone(env.state));

    await env.controller.runWatchHeartbeat();

    expect(watcher.tick).toHaveBeenCalledOnce();
    expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt)
      .toBe("2026-09-02T12:01:00.000Z");
  });

  it("normalizes an invalid persisted due time with exactly one immediate restart attempt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
    const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
    const env = tablessEnv();
    env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
    env.state.authHealth.twitch = { status: "healthy" };
    env.state.sessions.twitch = {
      platform: "twitch",
      status: "watching",
      offlineChecks: 0,
      watchMode: "tabless",
      channel: channel("twitch"),
      campaignId: "twitch-campaign",
      rewardId: "reward",
    };
    const contextKey = heartbeatContextKey(env.state.sessions.twitch)!;
    env.state.sessions.twitch.tablessHeartbeat = {
      generation: 7,
      contextKey,
      nextDueAt: "not-a-date",
    };
    env.deps.loadState.mockImplementation(async () => structuredClone(env.state));

    await env.controller.runWatchHeartbeat();

    expect(watcher.tick).toHaveBeenCalledOnce();
    expect(env.state.sessions.twitch.tablessHeartbeat).toEqual({
      generation: 8,
      contextKey,
      nextDueAt: "2026-09-02T12:01:00.000Z",
    });
  });

  it.each([
    { metadata: "missing cadence", build: () => undefined, expectedGeneration: 1 },
    {
      metadata: "missing generation",
      build: (contextKey: string) => ({ contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "null generation",
      build: (contextKey: string) => ({ generation: null, contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "string generation",
      build: (contextKey: string) => ({ generation: "7", contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "fractional generation",
      build: (contextKey: string) => ({ generation: 7.5, contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "unsafe generation",
      build: (contextKey: string) => ({ generation: Number.MAX_SAFE_INTEGER + 1, contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "NaN generation",
      build: (contextKey: string) => ({ generation: Number.NaN, contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "zero generation",
      build: (contextKey: string) => ({ generation: 0, contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "negative generation",
      build: (contextKey: string) => ({ generation: -7, contextKey, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 1,
    },
    {
      metadata: "mismatched context key",
      build: () => ({ generation: 7, contextKey: "obsolete-context", nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 8,
    },
    {
      metadata: "missing context key",
      build: () => ({ generation: 7, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 8,
    },
    {
      metadata: "null context key",
      build: () => ({ generation: 7, contextKey: null, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 8,
    },
    {
      metadata: "numeric context key",
      build: () => ({ generation: 7, contextKey: 42, nextDueAt: "2026-09-02T12:00:00.000Z" }),
      expectedGeneration: 8,
    },
    {
      metadata: "missing due timestamp",
      build: (contextKey: string) => ({ generation: 7, contextKey }),
      expectedGeneration: 8,
    },
    {
      metadata: "null due timestamp",
      build: (contextKey: string) => ({ generation: 7, contextKey, nextDueAt: null }),
      expectedGeneration: 8,
    },
    {
      metadata: "numeric due timestamp",
      build: (contextKey: string) => ({ generation: 7, contextKey, nextDueAt: 0 }),
      expectedGeneration: 8,
    },
  ] as const)(
    "reconstructs $metadata with a safe generation and one immediate heartbeat",
    async ({ build, expectedGeneration }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = tablessEnv();
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      env.state.authHealth.twitch = { status: "healthy" };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        offlineChecks: 0,
        watchMode: "tabless",
        channel: channel("twitch"),
        campaignId: "twitch-campaign",
        rewardId: "reward",
      };
      const contextKey = heartbeatContextKey(env.state.sessions.twitch)!;
      env.state.sessions.twitch.tablessHeartbeat = build(contextKey) as WatchSession["tablessHeartbeat"];
      env.deps.loadState.mockImplementation(async () => structuredClone(env.state));

      await env.controller.runWatchHeartbeat();

      expect(watcher.tick).toHaveBeenCalledOnce();
      expect(env.state.sessions.twitch.tablessHeartbeat).toEqual({
        generation: expectedGeneration,
        contextKey,
        nextDueAt: "2026-09-02T12:01:00.000Z",
      });
      expect(Number.isSafeInteger(env.state.sessions.twitch.tablessHeartbeat?.generation)).toBe(true);
    },
  );

  it.each([
    {
      timing: "before",
      now: "2026-09-02T12:00:59.999Z",
      attempts: 0,
      nextDueAt: "2026-09-02T12:01:00.000Z",
    },
    {
      timing: "after",
      now: "2026-09-02T12:04:15.000Z",
      attempts: 1,
      nextDueAt: "2026-09-02T12:05:00.000Z",
    },
  ] as const)(
    "honors persisted cadence $timing its due time on service-worker restart",
    async ({ now, attempts, nextDueAt }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now));
      const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }));
      const env = tablessEnv();
      env.twitch.createTablessWatcher = () => watcher as unknown as TablessWatchController;
      env.state.authHealth.twitch = { status: "healthy" };
      env.state.sessions.twitch = {
        platform: "twitch",
        status: "watching",
        offlineChecks: 0,
        watchMode: "tabless",
        channel: channel("twitch"),
        campaignId: "twitch-campaign",
        rewardId: "reward",
      };
      env.state.sessions.twitch.tablessHeartbeat = dueHeartbeatCadence(
        env.state.sessions.twitch,
        Date.parse("2026-09-02T12:01:00.000Z"),
      );

      await env.controller.runWatchHeartbeat();

      expect(watcher.tick).toHaveBeenCalledTimes(attempts);
      expect(env.state.sessions.twitch.tablessHeartbeat?.nextDueAt).toBe(nextDueAt);
      expect(env.twitch.refreshCampaigns).not.toHaveBeenCalled();
    },
  );
});
