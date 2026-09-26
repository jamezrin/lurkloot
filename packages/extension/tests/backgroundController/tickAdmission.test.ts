import { afterEach, describe, expect, it, vi } from "vitest";
import type { DropCampaign } from "@lurkloot/shared/models";
import type { DiagnosticEvent } from "@lurkloot/shared/events";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { selectWatchTargetFromSnapshot } from "@lurkloot/core/scheduler";
import { allDiagnostics, asSnapshot, campaign, deferred, farming, harness } from "../helpers/backgroundController";

// Tick admission, tick results and controller runs.

describe("background controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the state committed by the current tick invocation", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    const committed = await env.controller.tickAndHandOff(["twitch"]);

    expect(committed).toEqual(env.state);
    expect(committed?.sessions.twitch.campaignId).toBe("twitch-campaign");
  });

  it("does not return a scheduler snapshot when the tick rolls back", async () => {
    const env = harness(farming({ ...DEFAULT_SETTINGS, tablessMode: true }));
    env.twitch.supportsTabless = true;
    env.twitch.createTablessWatcher = () => {
      throw new Error("watcher setup failed");
    };

    const committed = await env.controller.tickAndHandOff(["twitch"]);

    expect(committed).toBeUndefined();
  });

  it("keeps committed results scoped to overlapping tick invocations", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const twitchDiscovery = deferred<DropCampaign[]>();
    const kickDiscovery = deferred<DropCampaign[]>();
    vi.mocked(env.twitch.refreshCampaigns).mockReturnValueOnce(twitchDiscovery.promise);
    vi.mocked(env.kick.refreshCampaigns).mockReturnValueOnce(kickDiscovery.promise);

    const twitchTick = env.controller.tickAndHandOff(["twitch"]);
    const kickTick = env.controller.tickAndHandOff(["kick"]);
    kickDiscovery.resolve([campaign("kick")]);
    const kickCommitted = await kickTick;
    twitchDiscovery.resolve([campaign("twitch")]);
    const twitchCommitted = await twitchTick;

    expect(kickCommitted?.sessions.kick.campaignId).toBe("kick-campaign");
    expect(twitchCommitted?.sessions.twitch.campaignId).toBe("twitch-campaign");
  });

  it("returns the latest committed platform state when Kick completes last", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const discovery = deferred<DropCampaign[]>();
    vi.mocked(env.kick.refreshCampaigns).mockReturnValueOnce(discovery.promise);
    const ticking = env.controller.tickAndHandOff();
    await vi.waitFor(() => expect(env.state.sessions.twitch.campaignId).toBe("twitch-campaign"));
    discovery.resolve([campaign("kick")]);
    const committed = await ticking;
    expect(committed?.sessions.kick.campaignId).toBe("kick-campaign");
    expect(committed?.sessions.twitch.campaignId).toBe("twitch-campaign");
  });

  it("brackets every tick with a lifecycle diagnostic naming its trigger and duration", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.tick(["twitch"], "manual_tick");

    const diagnostics = env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .filter((event): event is DiagnosticEvent => event.category === "diagnostic");
    expect(diagnostics).toContainEqual(expect.objectContaining({
      platform: "twitch",
      globalTickId: 1,
      platformTickId: 1,
      message: expect.stringMatching(/^Tick #\d+ started \(trigger=manual_tick, platforms=twitch\)$/),
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      platform: "twitch",
      globalTickId: 1,
      platformTickId: 1,
      code: "auth_health_changed",
      mirroredActivity: true,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      platform: "twitch",
      globalTickId: 1,
      platformTickId: 1,
      message: expect.stringMatching(/^Tick #\d+ refreshed auth health in \d+ms$/),
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      platform: "twitch",
      globalTickId: 1,
      platformTickId: 1,
      message: expect.stringMatching(/^Campaign refresh finished in \d+ms/),
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      platform: "twitch",
      globalTickId: 1,
      platformTickId: 1,
      message: expect.stringMatching(/^Tick #\d+ finished after \d+ms \(trigger=manual_tick, platforms=twitch\)$/),
    }));
  });

  it("coalesces same-platform ticks before discovery or the scheduler lock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    const env = harness(farming(DEFAULT_SETTINGS));
    const twitchDiscovery = deferred<DropCampaign[]>();
    const firstDiscoveryStarted = deferred<void>();
    let discoveryCalls = 0;
    env.twitch.refreshCampaigns = vi.fn(async () => {
      discoveryCalls += 1;
      if (discoveryCalls === 1) {
        firstDiscoveryStarted.resolve();
        await twitchDiscovery.promise;
      }
      return [];
    });
    const firstTick = env.rawController.tick(["twitch"], "manual_tick");
    let secondTick: ReturnType<typeof env.rawController.tick> | undefined;

    try {
      await firstDiscoveryStarted.promise;
      secondTick = env.rawController.tick(["twitch"], "manual_tick");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await vi.advanceTimersByTimeAsync(75);
      twitchDiscovery.resolve([]);
      await Promise.all([firstTick, secondTick]);

      expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        message: "Coalesced scheduler triggers (count=1, reasons=manual_tick:1)",
      }));
      expect(allDiagnostics(env).some((event) =>
        event.message.includes("waited") && event.message.includes("platform work"),
      )).toBe(false);
    } finally {
      twitchDiscovery.resolve([]);
      await Promise.allSettled(secondTick ? [firstTick, secondTick] : [firstTick]);
      vi.useRealTimers();
    }
  });

  it("admits one Twitch tick and one follow-up across repeated alarm intervals while Kick progresses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = harness(farming(DEFAULT_SETTINGS));
    const discovery = deferred<DropCampaign[]>();
    vi.mocked(env.twitch.refreshCampaigns).mockReturnValueOnce(discovery.promise);
    const first = env.controller.tickAndHandOff(["twitch"], "alarm");
    await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
    const pending: Promise<unknown>[] = [];
    for (let interval = 0; interval < 5; interval += 1) {
      vi.setSystemTime(Date.now() + 60_000);
      pending.push(env.controller.tickAndHandOff(["twitch"], "alarm"));
    }
    const sharedPending = pending.every((request) => request === pending[0]);
    await env.controller.tickAndHandOff(["kick"], "alarm");
    expect(env.state.sessions.kick.campaignId).toBe("kick-campaign");
    const starts = () => allDiagnostics(env).filter((event) => event.platform === "twitch" && /Tick #\d+ started/.test(event.message));
    const activeStarts = starts().length;
    discovery.resolve([campaign("twitch")]);
    await Promise.all([first, ...pending]);
    expect(activeStarts).toBe(1);
    expect(sharedPending).toBe(true);
    expect(starts()).toHaveLength(2);
    expect(env.twitch.checkAuthHealth).toHaveBeenCalledTimes(2);
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(2);
    expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
      platform: "twitch",
      message: expect.stringContaining("Coalesced scheduler triggers (count=5, reasons=alarm:5)"),
    }));
    expect(allDiagnostics(env).filter((event) => event.platform === "twitch" && /Tick #2 finished/.test(event.message))[0]?.message).toContain("after 0ms");
  });

  it.each(["manual_tick", "manual_resume", "claim_handoff"] as const)("preserves %s backoff overrides behind a pending alarm", async (trigger) => {
    const env = harness(farming(DEFAULT_SETTINGS), { selectWatchTarget: selectWatchTargetFromSnapshot });
    const discovery = deferred<DropCampaign[]>();
    vi.mocked(env.twitch.refreshCampaigns).mockReturnValueOnce(discovery.promise);
    const first = env.controller.tick(["twitch"], "alarm");
    await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
    const pending = env.controller.tick(["twitch"], "alarm");
    const manual = env.controller.tick(["twitch"], trigger);
    const laterAlarm = env.controller.tick(["twitch"], "alarm");
    discovery.resolve([campaign("twitch")]);
    await Promise.all([first, pending, manual, laterAlarm]);
    expect(env.deps.selectWatchTarget).toHaveBeenCalledTimes(2);
    expect(env.deps.selectWatchTarget).toHaveBeenLastCalledWith(expect.objectContaining({ bypassBackoff: true }));
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(2);
  });

  it("reloads settings and state and selects from the newest discovery revision for the follow-up", async () => {
    const env = harness(farming(DEFAULT_SETTINGS), { selectWatchTarget: selectWatchTargetFromSnapshot });
    const discovery = deferred<DropCampaign[]>();
    vi.mocked(env.twitch.refreshCampaigns)
      .mockReturnValueOnce(discovery.promise)
      .mockResolvedValue([{ ...campaign("twitch"), id: "new-campaign" }]);
    const first = env.controller.tickAndHandOff(["twitch"], "alarm");
    await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
    const pending = env.controller.tickAndHandOff(["twitch"], "alarm");
    await env.rawController.handleMessage({
      type: "saveSettings", settingsPatch: { autoClaim: false }, tickAfterSave: true, tickAfterSavePlatforms: ["twitch"],
    });
    await env.deps.saveState({ ...env.state, sessions: { ...env.state.sessions, twitch: { ...env.state.sessions.twitch, offlineChecks: 7 } } });
    discovery.resolve([campaign("twitch")]);
    await Promise.all([first, pending]);
    await env.controller.settleBackgroundWork();
    expect(env.deps.selectWatchTarget).toHaveBeenLastCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ autoClaim: false }),
      previous: expect.objectContaining({ offlineChecks: 7 }),
      snapshot: expect.objectContaining({ campaigns: [expect.objectContaining({ campaign: expect.objectContaining({ id: "new-campaign" }) })] }),
    }));
    expect(env.state.sessions.twitch.campaignId).toBe("new-campaign");
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(2);
  });

  it("executes the pending request after the active selection rejects", async () => {
    const selection = deferred<void>();
    const started = deferred<void>();
    let attempts = 0;
    const env = harness(farming(DEFAULT_SETTINGS), {
      selectWatchTarget: async (input) => {
        attempts += 1;
        if (attempts === 1) {
          started.resolve();
          await selection.promise;
        }
        return selectWatchTargetFromSnapshot(input);
      },
    });
    const first = env.controller.tickAndHandOff(["twitch"], "alarm");
    await started.promise;
    const pending = env.controller.tickAndHandOff(["twitch"], "alarm");
    const results = Promise.allSettled([first, pending]);
    selection.reject(new Error("selection failed"));
    expect((await results).map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(env.state.sessions.twitch.campaignId).toBe("twitch-campaign");
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(2);
  });

  it.each(["shutdown", "reset", "disable"] as const)("discards obsolete pending alarm work on %s", async (action) => {
    const env = harness(farming(DEFAULT_SETTINGS));
    const discovery = deferred<DropCampaign[]>();
    vi.mocked(env.twitch.refreshCampaigns).mockReturnValueOnce(discovery.promise);
    const first = env.controller.tickAndHandOff(["twitch"], "alarm");
    await vi.waitFor(() => expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce());
    const pending = env.controller.tickAndHandOff(["twitch"], "alarm");
    if (action === "shutdown") env.controller.shutdown();
    else if (action === "reset") await env.controller.prepareForHostReset();
    else await env.rawController.handleMessage({ type: "setAutomation", platform: "twitch", enabled: false });
    discovery.resolve([campaign("twitch")]);
    await Promise.all([first, pending]);
    await env.controller.settleBackgroundWork();
    expect(allDiagnostics(env).filter((event) => event.platform === "twitch" && event.message.includes("started (trigger=alarm"))).toHaveLength(1);
    expect(env.twitch.refreshCampaigns).toHaveBeenCalledOnce();
    expect(allDiagnostics(env)).toContainEqual(expect.objectContaining({
      message: expect.stringMatching(/Discarded pending scheduler triggers .*count=1, reasons=alarm:1/),
    }));
  });

  it("does not report platform-lock waits for an uncontended tick", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.tick(["twitch"], "manual_tick");

    expect(allDiagnostics(env).some((event) =>
      event.message.includes("waited") && event.message.includes("platform work"),
    )).toBe(false);
  });

  it("assigns global and platform-local identifiers to interleaved platform ticks", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.tick(["twitch"], "manual_tick");
    await env.controller.tick(["kick"], "manual_tick");
    await env.controller.tick(["twitch"], "manual_tick");

    const starts = env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .filter((event): event is DiagnosticEvent =>
        event.category === "diagnostic" && event.message.includes("started (trigger=manual_tick"));

    expect(starts.map((event) => ({
      platform: event.platform,
      globalTickId: event.globalTickId,
      platformTickId: event.platformTickId,
      message: event.message,
    }))).toEqual([
      {
        platform: "twitch",
        globalTickId: 1,
        platformTickId: 1,
        message: "Tick #1 started (trigger=manual_tick, platforms=twitch)",
      },
      {
        platform: "kick",
        globalTickId: 2,
        platformTickId: 1,
        message: "Tick #1 started (trigger=manual_tick, platforms=kick)",
      },
      {
        platform: "twitch",
        globalTickId: 3,
        platformTickId: 2,
        message: "Tick #2 started (trigger=manual_tick, platforms=twitch)",
      },
    ]);
  });

  it("announces one controller run and correlates all of its diagnostics", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    await env.controller.handleMessage({
      type: "setAutomation",
      platform: "twitch",
      enabled: true,
    });
    await env.controller.settleBackgroundWork();

    const diagnostics = env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .filter((event): event is DiagnosticEvent => event.category === "diagnostic");
    const boundaries = diagnostics.filter((event) =>
      event.message.startsWith("Background controller run "));
    const runId = boundaries[0]?.controllerRunId;

    expect(boundaries).toHaveLength(1);
    expect(diagnostics.findIndex((event) =>
      event.message.startsWith("Background controller run "))).toBe(0);
    expect(runId).toEqual(expect.any(String));
    expect(diagnostics.every((event) => event.controllerRunId === runId)).toBe(true);
    const requested = diagnostics.find((event) =>
      event.message === "User requested Twitch automation enable");
    expect(requested).toBeDefined();
    expect(requested).not.toHaveProperty("globalTickId");
    expect(requested).not.toHaveProperty("platformTickId");
  });

  it("gives independent controller runs different IDs despite identical first tick labels", async () => {
    const first = harness(farming(DEFAULT_SETTINGS));
    const second = harness(farming(DEFAULT_SETTINGS));

    await first.controller.tick(["twitch"], "manual_tick");
    await second.controller.tick(["twitch"], "manual_tick");

    const tickStart = (env: ReturnType<typeof harness>) => env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .find((event): event is DiagnosticEvent =>
        event.category === "diagnostic"
        && event.message === "Tick #1 started (trigger=manual_tick, platforms=twitch)");
    const firstTick = tickStart(first);
    const secondTick = tickStart(second);

    expect(firstTick).toBeDefined();
    expect(secondTick).toBeDefined();
    expect(firstTick?.message).toBe("Tick #1 started (trigger=manual_tick, platforms=twitch)");
    expect(secondTick?.message).toBe("Tick #1 started (trigger=manual_tick, platforms=twitch)");
    expect(firstTick?.controllerRunId).toEqual(expect.any(String));
    expect(secondTick?.controllerRunId).toEqual(expect.any(String));
    expect(firstTick?.controllerRunId).not.toBe(secondTick?.controllerRunId);
  });

  it("reports a tick lifecycle even when the tick throws", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));
    env.deps.saveState.mockRejectedValue(new Error("storage unavailable"));

    await expect(env.controller.tick(["twitch"], "alarm")).rejects.toThrow("storage unavailable");

    const messages = env.reportEvents.mock.calls
      .flatMap(([events]) => events)
      .filter((event) => event.category === "diagnostic")
      .map((event) => event.message);
    expect(messages).toContainEqual(expect.stringMatching(/^Tick #\d+ finished after \d+ms \(trigger=alarm/));
  });

  it("runs an immediate scheduler tick when requested from the popup", async () => {
    const env = harness(farming(DEFAULT_SETTINGS));

    const snapshot = asSnapshot(await env.controller.handleMessage({ type: "tickNow" }));

    expect(env.twitch.refreshCampaigns).toHaveBeenCalledTimes(1);
    expect(env.kick.refreshCampaigns).toHaveBeenCalledTimes(1);
    expect(snapshot.state.sessions.twitch.status).toBe("watching");
    expect(snapshot.state.sessions.kick.status).toBe("watching");
    expect(env.reportEvents).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ category: "activity", code: "farming_started" }),
    ]));
  });
});
