import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_JOBS,
  KICK_ALARM_NAME,
  KICK_CHALLENGES_ALARM_NAME,
  KICK_DROP_CLAIMS_ALARM_NAME,
  TWITCH_ALARM_NAME,
  TWITCH_CHANNEL_POINTS_ALARM_NAME,
  TWITCH_DROP_CLAIMS_ALARM_NAME,
  TWITCH_INTEGRITY_ALARM_NAME,
  WATCH_ALARM_NAME,
} from "@lurkloot/core/controller";
import { integrityBundle, integrityHeaders } from "./helpers/backgroundController";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { TablessWatchController } from "@lurkloot/core/tablessWatch";
import type { DropCampaign, SchedulerState, WatchSession } from "@lurkloot/shared/models";
import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import {
  CAPABILITY_SETS,
  contractCampaign,
  contractChannel,
  contractHost,
  deferred,
  farmingSettings,
  idleState,
  type ContractHost,
} from "./helpers/controllerContract";

// Contract tests for the background controller, run once per declared host
// capability set (#584). They pin what v1.14.0 does on each host, so v1.15.0's
// extractions (#583) either keep it or change it on purpose, in a PR labelled
// behavior-change. Where the hosts differ today, the test says so and names the
// issue that aligns them.

const tickStarts = (host: ContractHost, platform: "twitch" | "kick") =>
  host.reported.filter((event) =>
    event.category === "diagnostic" && event.platform === platform && /Tick #\d+ started/.test(event.message)).length;

class FailingWatcher implements TablessWatchController {
  channelUrl: string | undefined;
  ticks = 0;
  constructor(readonly platform: "twitch" | "kick") {}
  async start(channel: { url: string }): Promise<void> {
    this.channelUrl = channel.url;
  }
  async tick() {
    this.ticks += 1;
    return { ok: false, live: true, message: "heartbeat rejected" };
  }
  drainEvents() {
    return [];
  }
  async stop(): Promise<void> {
    this.channelUrl = undefined;
  }
}

const twitchOnly = (overrides: Partial<ReturnType<typeof farmingSettings>> = {}) => {
  const settings = farmingSettings();
  return { ...settings, ...overrides, platform: { ...settings.platform, kick: { ...settings.platform.kick, enabled: false } } };
};

class CountingWatcher implements TablessWatchController {
  channelUrl: string | undefined;
  started = 0;
  ticks = 0;
  constructor(readonly platform: "twitch" | "kick") {}
  async start(channel: { url: string }): Promise<void> {
    this.started += 1;
    this.channelUrl = channel.url;
  }
  async tick() {
    this.ticks += 1;
    return { ok: true, live: true };
  }
  drainEvents() {
    return [];
  }
  async stop(): Promise<void> {
    this.channelUrl = undefined;
  }
}

// Records the locks held around each call the controller makes into it.
class LockRecordingWatcher implements TablessWatchController {
  channelUrl: string | undefined;
  readonly calls: Array<{ call: "start" | "tick" | "stop"; held: readonly string[] }> = [];
  constructor(readonly platform: "twitch" | "kick", private readonly heldLocks: () => readonly string[]) {}
  async start(channel: { url: string }): Promise<void> {
    this.calls.push({ call: "start", held: this.heldLocks() });
    this.channelUrl = channel.url;
  }
  async tick() {
    this.calls.push({ call: "tick", held: this.heldLocks() });
    return { ok: true, live: true };
  }
  drainEvents() {
    return [];
  }
  async stop(): Promise<void> {
    this.calls.push({ call: "stop", held: this.heldLocks() });
    this.channelUrl = undefined;
  }
}

function watchingState(): SchedulerState {
  const state = idleState();
  const watching = (platform: "twitch" | "kick"): WatchSession => ({
    platform,
    status: "watching",
    offlineChecks: 0,
    campaignId: `${platform}-campaign`,
    rewardId: `${platform}-reward`,
    channel: contractChannel(platform),
    watchMode: "tabless",
  });
  return {
    ...state,
    sessions: { twitch: watching("twitch"), kick: watching("kick") },
    campaigns: { twitch: [contractCampaign("twitch")], kick: [contractCampaign("kick")] },
  };
}

describe.each(CAPABILITY_SETS)("background controller contract: $name host", (capabilities) => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("tick admission", () => {
    it("admits one active tick and one shared follow-up per platform while the other platform progresses", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const host = contractHost(capabilities);
      const discovery = deferred<DropCampaign[]>();
      vi.mocked(host.adapters.twitch.refreshCampaigns).mockReturnValueOnce(discovery.promise);

      const first = host.controller.tickAndHandOff(["twitch"], "alarm");
      await vi.waitFor(() => expect(host.adapters.twitch.refreshCampaigns).toHaveBeenCalledOnce());
      const followUps: Promise<unknown>[] = [];
      for (let interval = 0; interval < 4; interval += 1) {
        vi.setSystemTime(Date.now() + 60_000);
        followUps.push(host.controller.tickAndHandOff(["twitch"], "alarm"));
      }

      // Kick is not held behind the blocked Twitch refresh.
      await host.controller.tickAndHandOff(["kick"], "alarm");
      expect(host.storage.state.sessions.kick.campaignId).toBe("kick-campaign");
      expect(followUps.every((request) => request === followUps[0])).toBe(true);

      discovery.resolve([contractCampaign("twitch")]);
      await Promise.all([first, ...followUps]);
      // The active tick plus exactly one coalesced follow-up.
      expect(tickStarts(host, "twitch")).toBe(2);
      expect(host.storage.state.sessions.twitch.campaignId).toBe("twitch-campaign");
    });

    // #571: a ranking-only save re-selects from the discovery already held, and
    // is the lowest-priority trigger, so any save that needs fresh discovery
    // wins when the two merge.
    it.each([
      { triggers: ["ranking_changed"], winner: "ranking_changed", refreshes: 1 },
      { triggers: ["ranking_changed", "settings_saved"], winner: "settings_saved", refreshes: 2 },
      { triggers: ["settings_saved", "ranking_changed"], winner: "settings_saved", refreshes: 2 },
    ] as const)("runs a $triggers follow-up as $winner, with $refreshes discovery refreshes in total", async ({ triggers, winner, refreshes }) => {
      const host = contractHost(capabilities);
      const discovery = deferred<DropCampaign[]>();
      vi.mocked(host.adapters.twitch.refreshCampaigns).mockReturnValueOnce(discovery.promise);

      const first = host.controller.tickAndHandOff(["twitch"], "alarm");
      await vi.waitFor(() => expect(host.adapters.twitch.refreshCampaigns).toHaveBeenCalledOnce());
      const followUps = triggers.map((trigger) => host.controller.tickAndHandOff(["twitch"], trigger));
      discovery.resolve([contractCampaign("twitch")]);
      await Promise.all([first, ...followUps]);

      expect(host.reported).toContainEqual(expect.objectContaining({
        category: "diagnostic",
        platform: "twitch",
        message: `Tick #2 started (trigger=${winner}, platforms=twitch)`,
      }));
      expect(host.adapters.twitch.refreshCampaigns).toHaveBeenCalledTimes(refreshes);
      host.controller.shutdown();
    });
  });

  describe("cancelled work", () => {
    it("publishes no state or activity from a tick cut off by shutdown", async () => {
      const host = contractHost(capabilities);
      const discovery = deferred<DropCampaign[]>();
      vi.mocked(host.adapters.twitch.refreshCampaigns).mockReturnValueOnce(discovery.promise);

      const tick = host.controller.tickAndHandOff(["twitch"], "alarm");
      await vi.waitFor(() => expect(host.adapters.twitch.refreshCampaigns).toHaveBeenCalledOnce());
      const savedBeforeShutdown = host.savedStates.length;
      const activityBeforeShutdown = host.reported.filter((event) => event.category === "activity").length;

      host.controller.shutdown();
      discovery.resolve([contractCampaign("twitch")]);
      await Promise.allSettled([tick]);
      await host.controller.settleBackgroundWork();

      expect(host.savedStates.slice(savedBeforeShutdown).some((state) => state.sessions.twitch.campaignId !== undefined)).toBe(false);
      expect(host.reported.filter((event) => event.category === "activity")).toHaveLength(activityBeforeShutdown);
      expect(host.storage.state.sessions.twitch.status).not.toBe("watching");
    });
  });

  // The claim failure model (#597): with no claim journal, the provider's
  // inventory decides what happened to a claim the previous process sent.
  describe("claim failure model", () => {
    it("sends no claim and publishes nothing for a reward the provider accepted before the save was lost", async () => {
      const claimable = { id: "twitch-reward", name: "Reward", requiredMinutes: 60, watchedMinutes: 60, status: "claimable" as const, claimId: "claim-1" };
      const previous = contractHost(capabilities, {
        settings: twitchOnly({ autoClaim: true }),
        state: { ...idleState(), campaigns: { twitch: [{ ...contractCampaign("twitch"), rewards: [claimable] }], kick: [] } },
      });
      const restarted = previous.restart();
      vi.mocked(restarted.adapters.twitch.refreshCampaigns).mockResolvedValue([
        { ...contractCampaign("twitch"), rewards: [{ ...claimable, status: "claimed" }] },
      ]);

      await restarted.boot();
      await restarted.controller.tickAndHandOff(["twitch"], "alarm");

      expect(restarted.adapters.twitch.claimReward).not.toHaveBeenCalled();
      expect(restarted.reported.some((event) => event.category === "activity" && event.code === "reward_claimed")).toBe(false);
      expect(restarted.storage.state.campaigns.twitch[0].rewards[0].status).toBe("claimed");
      restarted.controller.shutdown();
    });
  });

  // The post-claim handoff and its cancellation are the claim service's
  // (#597), and behave the same on both hosts.
  describe("post-claim handoff", () => {
    const handoffSettings = () => twitchOnly({ autoClaim: true, postClaimHandoff: true });

    it("moves on to the next reward once inventory reveals it", async () => {
      let reveal = false;
      const host = contractHost(capabilities, {
        settings: handoffSettings(),
        wait: async () => {
          reveal = true;
        },
      });
      host.adapters.twitch.supportsPostClaimHandoff = true;
      vi.mocked(host.adapters.twitch.refreshCampaigns).mockImplementation(async () => [{
        ...contractCampaign("twitch"),
        rewards: [
          { id: "twitch-reward", name: "Reward", requiredMinutes: 60, watchedMinutes: 60, status: "claimed" },
          ...(reveal ? [{ id: "next-reward", name: "Next", requiredMinutes: 60, watchedMinutes: 0, status: "in_progress" as const }] : []),
        ],
      }]);

      await host.controller.runClaimHandoff("twitch", ["twitch-reward"]);

      expect(host.storage.state.sessions.twitch).toMatchObject({ status: "watching", rewardId: "next-reward" });
      host.controller.shutdown();
    });

    it("ends a running handoff on shutdown without refreshing again", async () => {
      const parked: AbortSignal[] = [];
      const host = contractHost(capabilities, {
        settings: handoffSettings(),
        wait: (_ms, signal) => new Promise<void>((resolve) => {
          parked.push(signal);
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      });
      host.adapters.twitch.supportsPostClaimHandoff = true;

      const handoff = host.controller.runClaimHandoff("twitch", ["twitch-reward"]);
      await vi.waitFor(() => expect(parked).toHaveLength(1));
      host.controller.shutdown();
      await handoff;

      expect(parked[0].aborted).toBe(true);
      expect(host.adapters.twitch.refreshCampaigns).not.toHaveBeenCalled();
    });
  });

  describe("process restart", () => {
    // Both hosts run the shared restart reconciliation (#593; before it, the
    // CLI left these sessions to its ticks and heartbeats).
    it("pauses sessions left watching by the previous process, as a runtime restart, and releases their heartbeats", async () => {
      const previous = contractHost(capabilities, { state: watchingState() });
      const restarted = previous.restart();
      // Only the restart's own cleanup is under test here, not the farming it
      // resumes, so the first tick's discovery stays blocked.
      const discovery = deferred<DropCampaign[]>();
      vi.mocked(restarted.adapters.twitch.refreshCampaigns).mockReturnValue(discovery.promise);
      vi.mocked(restarted.adapters.kick.refreshCampaigns).mockReturnValue(discovery.promise);
      const watchers: CountingWatcher[] = [];
      for (const platform of ["twitch", "kick"] as const) {
        restarted.adapters[platform].createTablessWatcher = () => {
          const watcher = new CountingWatcher(platform);
          watchers.push(watcher);
          return watcher;
        };
      }

      const boot = restarted.boot();
      await vi.waitFor(() => expect(restarted.savedStates.length).toBeGreaterThan(0));
      const cleaned = restarted.savedStates[0];
      for (const platform of ["twitch", "kick"] as const) {
        expect(cleaned.sessions[platform]).toMatchObject({ status: "paused", reasonCode: "runtime_restart" });
        expect(cleaned.sessions[platform].channel).toBeUndefined();
      }
      // A heartbeat fire after the restart does not revive the previous watch.
      await restarted.fire(WATCH_ALARM_NAME);
      expect(watchers).toEqual([]);

      restarted.controller.shutdown();
      discovery.resolve([]);
      await Promise.allSettled([boot]);
    });
  });

  describe("jobs", () => {
    const CADENCE_JOBS = [TWITCH_ALARM_NAME, KICK_ALARM_NAME, WATCH_ALARM_NAME];

    // Behavior change (#590): the CLI registers the one-minute channel-points
    // job too, where it used to claim channel points only at poll cadence.
    it(capabilities.declared.browserTabs
      ? "registers the cadence jobs, the one-minute channel-points job and the claim jobs at startup"
      : "registers the tick and heartbeat cadence jobs and the one-minute channel-points job", async () => {
      const host = contractHost(capabilities);
      vi.mocked(host.adapters.twitch.refreshCampaigns).mockResolvedValue([]);
      vi.mocked(host.adapters.kick.refreshCampaigns).mockResolvedValue([]);
      await host.boot();
      await host.controller.tickAndHandOff(undefined, "alarm");
      const pollIntervalMinutes = host.storage.settings.pollIntervalMinutes;
      expect(host.jobs.scheduled.get(TWITCH_ALARM_NAME)).toEqual({ periodInMinutes: pollIntervalMinutes });
      expect(host.jobs.scheduled.get(KICK_ALARM_NAME)).toEqual({ periodInMinutes: pollIntervalMinutes });
      expect(host.jobs.scheduled.get(WATCH_ALARM_NAME)).toEqual({ periodInMinutes: 1 });
      expect(host.jobs.scheduled.get(TWITCH_CHANNEL_POINTS_ALARM_NAME)).toEqual({ periodInMinutes: 1 });
      if (capabilities.declared.browserTabs) {
        expect([...host.jobs.scheduled.keys()]).toEqual(expect.arrayContaining([
          ...CADENCE_JOBS,
          TWITCH_CHANNEL_POINTS_ALARM_NAME,
          TWITCH_DROP_CLAIMS_ALARM_NAME,
          KICK_DROP_CLAIMS_ALARM_NAME,
        ]));
      } else {
        expect([...host.jobs.scheduled.keys()].sort()).toEqual([...CADENCE_JOBS, TWITCH_CHANNEL_POINTS_ALARM_NAME].sort());
      }
      host.controller.shutdown();
    });

    it("never schedules a job whose capability the host does not declare", async () => {
      const host = contractHost(capabilities);
      await host.controller.ensureCadenceJobs();
      await host.controller.handleStartup();
      for (const [name, job] of Object.entries(BACKGROUND_JOBS)) {
        if (!job.requires || capabilities.declared[job.requires]) continue;
        expect(host.jobs.ensured).not.toContain(name);
      }
      host.controller.shutdown();
      await host.controller.settleBackgroundWork();
    });

    it("ignores a fire of an inert or unknown job", async () => {
      const host = contractHost(capabilities);
      const inert = Object.entries(BACKGROUND_JOBS)
        .filter(([, job]) => job.requires && !capabilities.declared[job.requires])
        .map(([name]) => name);
      for (const name of [...inert, "unrelated.alarm"]) await host.fire(name);
      expect(host.savedStates).toHaveLength(0);
      for (const platform of ["twitch", "kick"] as const) {
        expect(host.adapters[platform].refreshCampaigns).not.toHaveBeenCalled();
        expect(host.adapters[platform].claimReward).not.toHaveBeenCalled();
      }
      host.controller.shutdown();
    });

    it("coalesces duplicate tick job fires into one active tick and one follow-up", async () => {
      const host = contractHost(capabilities);
      const discovery = deferred<DropCampaign[]>();
      vi.mocked(host.adapters.twitch.refreshCampaigns).mockReturnValueOnce(discovery.promise);

      const fires = [host.fire(TWITCH_ALARM_NAME)];
      await vi.waitFor(() => expect(host.adapters.twitch.refreshCampaigns).toHaveBeenCalledOnce());
      for (let duplicate = 0; duplicate < 3; duplicate += 1) fires.push(host.fire(TWITCH_ALARM_NAME));
      discovery.resolve([contractCampaign("twitch")]);
      await Promise.all(fires);

      expect(tickStarts(host, "twitch")).toBe(2);
      expect(tickStarts(host, "kick")).toBe(0);
      host.controller.shutdown();
    });

    it("sends one heartbeat for duplicate or late watch job fires within one due period", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const host = contractHost(capabilities, { settings: { ...farmingSettings(), platform: { ...farmingSettings().platform, kick: { ...farmingSettings().platform.kick, enabled: false } } } });
      const watcher = new CountingWatcher("twitch");
      host.adapters.twitch.createTablessWatcher = () => watcher;
      await host.controller.tickAndHandOff(["twitch"], "alarm");
      expect(watcher.started).toBe(1);

      vi.setSystemTime(Date.now() + 60_000);
      await Promise.all([host.fire(WATCH_ALARM_NAME), host.fire(WATCH_ALARM_NAME)]);
      expect(watcher.ticks).toBe(1);
      // A fire delivered late, after its period already ran, is not a second heartbeat.
      await host.fire(WATCH_ALARM_NAME);
      expect(watcher.ticks).toBe(1);

      vi.setSystemTime(Date.now() + 60_000);
      await host.fire(WATCH_ALARM_NAME);
      expect(watcher.ticks).toBe(2);
      host.controller.shutdown();
    });

    // The integrity refresh job (#589) must be correct under duplicate and late
    // fires: one refresh runs at a time, and a fire that finds a token not yet
    // due only reschedules.
    it.runIf(capabilities.declared.twitchIntegrityCapture)("runs one integrity refresh for duplicate or late refresh job fires", async () => {
      const host = contractHost(capabilities);
      const refreshing = deferred<boolean>();
      vi.mocked(host.deps.ensureTwitchIntegrity!).mockImplementationOnce(async () => await refreshing.promise);

      const fires = [host.fire(TWITCH_INTEGRITY_ALARM_NAME)];
      await vi.waitFor(() => expect(host.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce());
      fires.push(host.fire(TWITCH_INTEGRITY_ALARM_NAME), host.fire(TWITCH_INTEGRITY_ALARM_NAME));
      await Promise.all(fires.slice(1));
      expect(host.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce();
      await host.controller.captureTwitchIntegrity(integrityHeaders(integrityBundle()));
      refreshing.resolve(true);
      await Promise.all(fires);

      // Late: the token captured meanwhile is not due, so the fire only reschedules.
      await host.fire(TWITCH_INTEGRITY_ALARM_NAME);
      expect(host.deps.ensureTwitchIntegrity).toHaveBeenCalledOnce();
      expect(host.jobs.scheduled.get(TWITCH_INTEGRITY_ALARM_NAME)).toMatchObject({ when: expect.any(Number) });
      host.controller.shutdown();
    });

    it("runs no job after shutdown", async () => {
      const host = contractHost(capabilities);
      host.controller.shutdown();
      for (const name of Object.keys(BACKGROUND_JOBS)) await host.fire(name);
      await host.controller.settleBackgroundWork();
      expect(host.savedStates).toHaveLength(0);
      for (const platform of ["twitch", "kick"] as const) {
        expect(host.adapters[platform].refreshCampaigns).not.toHaveBeenCalled();
      }
    });
  });

  describe("capabilities", () => {
    it("declares its capabilities to the controller", () => {
      const host = contractHost(capabilities);
      expect(host.controller.capabilities).toEqual(capabilities.declared);
      host.controller.shutdown();
    });

    it(capabilities.declared.browserTabs
      ? "reports nothing about tab settings, which this host supports"
      : "reports each tab setting it cannot honor once, as an English diagnostic", async () => {
      const settings = { ...farmingSettings(), tablessMode: false, pauseOnManualWatch: true };
      const host = contractHost(capabilities, { settings });
      await host.controller.tickAndHandOff(["twitch"], "alarm");
      await host.controller.tickAndHandOff(["kick"], "alarm");
      await host.controller.tickAndHandOff(undefined, "alarm");
      const unsupported = host.reported.filter((event) =>
        event.category === "diagnostic" && event.message.startsWith("This host has no browser tabs, so"));
      if (capabilities.declared.browserTabs) {
        expect(unsupported).toEqual([]);
      } else {
        expect(unsupported.map((event) => event.message)).toEqual([
          "This host has no browser tabs, so tablessMode=false has no effect: every watch is tabless",
          "This host has no browser tabs, so pauseOnManualWatch has no effect",
        ]);
        expect(unsupported.every((event) => event.platform === undefined)).toBe(true);
      }
      host.controller.shutdown();
    });
  });

  // Tabless watching is derived from the missing browserTabs capability, not
  // configured (#598): a host without tabs never asks for one.
  describe("watch surface", () => {
    it(capabilities.declared.browserTabs
      ? "opens a watch tab when tablessMode is off"
      : "watches tabless even when tablessMode is off", async () => {
      const host = contractHost(capabilities, { settings: twitchOnly({ tablessMode: false }) });
      const watcher = new CountingWatcher("twitch");
      host.adapters.twitch.createTablessWatcher = () => watcher;
      await host.controller.tickAndHandOff(["twitch"], "alarm");

      if (capabilities.declared.browserTabs) {
        expect(host.storage.state.sessions.twitch).toMatchObject({ status: "watching", watchMode: "tab" });
        expect(host.deps.openWatchTab).toHaveBeenCalledOnce();
        expect(watcher.started).toBe(0);
      } else {
        expect(host.storage.state.sessions.twitch).toMatchObject({ status: "watching", watchMode: "tabless" });
        expect(watcher.started).toBe(1);
      }
      host.controller.shutdown();
    });

    it(capabilities.declared.browserTabs
      ? "falls back to a watch tab when heartbeats keep failing"
      : "stays tabless when heartbeats keep failing, with nothing to fall back to", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const host = contractHost(capabilities, { settings: twitchOnly({ tablessFallbackFailureLimit: 1 }) });
      const watcher = new FailingWatcher("twitch");
      host.adapters.twitch.createTablessWatcher = () => watcher;
      await host.controller.tickAndHandOff(["twitch"], "alarm");
      expect(host.storage.state.sessions.twitch).toMatchObject({ watchMode: "tabless" });

      vi.setSystemTime(Date.now() + 60_000);
      await host.fire(WATCH_ALARM_NAME);
      await host.controller.settleBackgroundWork();
      expect(watcher.ticks).toBe(1);
      const fallbackReported = host.reported.some((event) =>
        event.category === "diagnostic" && event.message === "Tabless watch heartbeat keeps failing; falling back to a watch tab");

      if (capabilities.declared.browserTabs) {
        expect(fallbackReported).toBe(true);
        expect(host.storage.state.sessions.twitch).toMatchObject({ watchMode: "tab" });
        expect(host.deps.openWatchTab).toHaveBeenCalledOnce();
      } else {
        expect(fallbackReported).toBe(false);
        expect(host.storage.state.sessions.twitch).toMatchObject({ watchMode: "tabless", heartbeatChecks: 1 });
        // The next tick sees the failure count past the limit and still keeps
        // the watch tabless instead of asking a host without tabs for one.
        await host.controller.tickAndHandOff(["twitch"], "alarm");
        expect(host.storage.state.sessions.twitch).toMatchObject({ status: "watching", watchMode: "tabless" });
        expect(host.reported.filter((event) => event.category === "diagnostic" && event.level === "error")).toEqual([]);
      }
      host.controller.shutdown();
    });

    // No lock is held while a watcher starts, sends a heartbeat or stops (#586):
    // not the tick's platform lock, not the heartbeat lane.
    it("starts, beats and stops tabless watchers with no lock held", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const host = contractHost(capabilities, { settings: twitchOnly() });
      const watchers: LockRecordingWatcher[] = [];
      host.adapters.twitch.createTablessWatcher = () => {
        const watcher = new LockRecordingWatcher("twitch", host.heldLocks);
        watchers.push(watcher);
        return watcher;
      };
      await host.controller.tickAndHandOff(["twitch"], "alarm");
      vi.setSystemTime(Date.now() + 60_000);
      await host.fire(WATCH_ALARM_NAME);
      // A new target replaces the watcher.
      vi.mocked(host.adapters.twitch.refreshCampaigns).mockResolvedValue([{ ...contractCampaign("twitch"), id: "successor-campaign" }]);
      vi.mocked(host.adapters.twitch.listCandidateChannels).mockResolvedValue([{ ...contractChannel("twitch"), campaignId: "successor-campaign" }]);
      await host.controller.tickAndHandOff(["twitch"], "alarm");
      // A new process recovers the persisted watch on its first heartbeat.
      host.controller.shutdown();
      const restarted = contractHost(capabilities, { settings: twitchOnly(), storage: host.storage });
      restarted.adapters.twitch.createTablessWatcher = () => {
        const watcher = new LockRecordingWatcher("twitch", restarted.heldLocks);
        watchers.push(watcher);
        return watcher;
      };
      await restarted.fire(WATCH_ALARM_NAME);

      const calls = watchers.flatMap((watcher) => watcher.calls);
      expect(calls.map(({ call }) => call)).toEqual(expect.arrayContaining(["start", "tick", "stop"]));
      expect(watchers.length).toBeGreaterThanOrEqual(3);
      expect(calls.filter(({ held }) => held.length > 0)).toEqual([]);
      restarted.controller.shutdown();
    });

    // A tabless-only supplemental session (Twitch Extensions, #541/#556) never
    // falls back to a tab, whatever its failure count (#586).
    it.runIf(capabilities.declared.supplementalSources)("keeps a tabless-only supplemental watch tabless when heartbeats keep failing", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const host = contractHost(capabilities, { settings: twitchOnly({ tablessMode: false, tablessFallbackFailureLimit: 1 }) });
      vi.mocked(host.adapters.twitch.refreshCampaigns).mockResolvedValue([]);
      vi.mocked(host.deps.selectSupplementalWatchTarget!).mockResolvedValue({
        id: "nopixel",
        tablessOnly: true,
        channel: { ...contractChannel("twitch"), campaignId: undefined, live: true },
      });
      const watcher = new FailingWatcher("twitch");
      host.adapters.twitch.createTablessWatcher = () => watcher;
      await host.controller.tickAndHandOff(["twitch"], "alarm");
      expect(host.storage.state.sessions.twitch).toMatchObject({ watchMode: "tabless", supplementalWatch: { tablessOnly: true } });

      for (let failure = 1; failure <= 3; failure += 1) {
        vi.setSystemTime(Date.now() + 60_000);
        await host.fire(WATCH_ALARM_NAME);
        await host.controller.settleBackgroundWork();
        expect(host.storage.state.sessions.twitch).toMatchObject({ watchMode: "tabless", heartbeatChecks: failure });
        // A poll tick past the limit keeps it tabless too.
        await host.controller.tickAndHandOff(["twitch"], "alarm");
      }

      expect(watcher.ticks).toBe(3);
      expect(host.storage.state.sessions.twitch).toMatchObject({ status: "watching", watchMode: "tabless" });
      expect(host.deps.openWatchTab).not.toHaveBeenCalled();
      expect(host.reported.some((event) =>
        event.category === "diagnostic" && event.message === "Tabless watch heartbeat keeps failing; falling back to a watch tab")).toBe(false);
      host.controller.shutdown();
    });
  });

  // The extension's real tab ports, run against a fake browser (#598). Every
  // close the extension makes records why, so only the user's own close pauses
  // the platform (#640), and a report from a tab the extension already closed
  // is not the user watching (#641).
  // #596: a manual-watch tick starts from the commit that starts or ends the
  // user's viewing, never from a tick's own commit. Without browser tabs
  // nothing reports viewing, so manual watch stays inactive.
  describe("manual watch", () => {
    it("never starts a manual-watch tick from the scheduler's own commits", async () => {
      const host = contractHost(capabilities, { settings: twitchOnly() });

      await host.controller.tickAndHandOff(["twitch"], "alarm");
      await host.controller.tickAndHandOff(["twitch"], "alarm");
      await host.controller.settleBackgroundWork();

      expect(host.storage.state.manualWatch?.twitch).toBeUndefined();
      expect(host.reported.filter((event) =>
        event.category === "diagnostic" && event.message.includes("trigger=manual_watch"))).toEqual([]);
      host.controller.shutdown();
    });
  });

  describe("browser tabs", () => {
    const playing = { videoCount: 1, mutedVideoCount: 0, unmutedVideoCount: 1, playingVideoCount: 1, blockedPlaybackCount: 0, documentHidden: false };

    async function watchInTab(host: ContractHost): Promise<number> {
      await host.controller.tickAndHandOff(["twitch"], "alarm");
      const tabId = host.storage.state.sessions.twitch.tabId;
      expect(host.storage.state.sessions.twitch).toMatchObject({ status: "watching", watchMode: "tab", tabManagedByExtension: true });
      expect(tabId !== undefined && host.browser?.has(tabId)).toBe(true);
      return tabId!;
    }

    async function finishCampaign(host: ContractHost): Promise<void> {
      vi.mocked(host.adapters.twitch.refreshCampaigns).mockResolvedValue([]);
      await host.controller.tickAndHandOff(["twitch"], "alarm");
      await host.settleTabEvents();
    }

    if (!capabilities.declared.browserTabs) {
      it("has no tabs, so a tab event changes nothing", async () => {
        const host = contractHost(capabilities, { settings: twitchOnly() });
        await host.controller.tickAndHandOff(["twitch"], "alarm");
        const before = structuredClone(host.storage.state);
        await host.controller.handleTabRemoved(123);
        await host.controller.settleBackgroundWork();
        expect(host.storage.state).toEqual(before);
        host.controller.shutdown();
      });
      return;
    }

    it("pauses the platform when the user closes its watch tab", async () => {
      const host = contractHost(capabilities, { settings: twitchOnly({ tablessMode: false }) });
      const tabId = await watchInTab(host);

      host.browser!.userClose(tabId);
      await host.settleTabEvents();

      expect(host.storage.state.manualClosePause?.twitch).toBeDefined();
      host.controller.shutdown();
    });

    it("closes its own watch tab without pausing when the campaign finishes", async () => {
      const host = contractHost(capabilities, { settings: twitchOnly({ tablessMode: false, autoCloseFinishedDrops: true }) });
      const tabId = await watchInTab(host);

      await finishCampaign(host);

      expect(host.browser!.has(tabId)).toBe(false);
      expect(host.storage.state.manualClosePause?.twitch).toBeUndefined();
      expect(host.storage.state.sessions.twitch.status).toBe("idle");
      host.controller.shutdown();
    });

    it("leaves the watch tab open, unpinned and unmuted, when auto-close is off", async () => {
      const host = contractHost(capabilities, { settings: twitchOnly({ tablessMode: false, autoCloseFinishedDrops: false }) });
      const tabId = await watchInTab(host);

      await finishCampaign(host);

      expect(host.browser!.tabList.get(tabId)).toMatchObject({ pinned: false, mutedInfo: { muted: false } });
      expect(host.storage.state.manualClosePause?.twitch).toBeUndefined();
      host.controller.shutdown();
    });

    it("ignores late playback from a watch tab it closed", async () => {
      const host = contractHost(capabilities, { settings: twitchOnly({ tablessMode: false, autoCloseFinishedDrops: true, pauseOnManualWatch: true }) });
      const tabId = await watchInTab(host);
      await finishCampaign(host);
      expect(host.browser!.has(tabId)).toBe(false);

      await host.controller.handleMessage(
        { type: "playbackTelemetry", platform: "twitch", telemetry: playing },
        { tab: { id: tabId, url: contractChannel("twitch").url } },
      );
      await host.controller.settleBackgroundWork();

      expect(host.storage.state.manualWatch?.twitch?.active).not.toBe(true);
      expect(host.storage.state.sessions.twitch.reasonCode).not.toBe("manual_watch");
      host.controller.shutdown();
    });

    // Holds the first browser call that configures a newly created tab, so the
    // tick is still opening it, and resolves with that tab's id.
    function holdNewTabConfiguration(host: ContractHost) {
      const browser = host.browser!;
      const create = browser.tabs.create;
      const update = browser.tabs.update;
      const opened = deferred<number>();
      const release = deferred<void>();
      let newTabId: number | undefined;
      let held = false;
      browser.tabs.create = async (properties) => {
        const tab = await create(properties);
        newTabId ??= tab.id;
        return tab;
      };
      browser.tabs.update = async (tabId, properties) => {
        if (tabId === newTabId && !held) {
          held = true;
          opened.resolve(tabId);
          await release.promise;
        }
        return await update(tabId, properties);
      };
      return { opened: opened.promise, release: () => release.resolve() };
    }

    it("does not read its new watch tab's playback as the user watching while the tab opens", async () => {
      const host = contractHost(capabilities, { settings: twitchOnly({ tablessMode: false, pauseOnManualWatch: true }) });
      const held = holdNewTabConfiguration(host);
      const ticking = host.controller.tickAndHandOff(["twitch"], "alarm");
      const tabId = await held.opened;

      // Priming brings the tab to the front, so it can report visible playback
      // before the tick that opened it commits.
      await host.controller.handleMessage(
        { type: "playbackTelemetry", platform: "twitch", telemetry: playing },
        { tab: { id: tabId, url: contractChannel("twitch").url } },
      );
      held.release();
      await ticking;
      await host.controller.tickAndHandOff(["twitch"], "alarm");
      await host.settleTabEvents();

      expect(host.storage.state.manualWatch?.twitch?.active).not.toBe(true);
      expect(host.storage.state.sessions.twitch).toMatchObject({ status: "watching", tabId });
      expect(host.browser!.has(tabId)).toBe(true);
      host.controller.shutdown();
    });

    it("closes a watch tab it was still preparing when the host resets", async () => {
      const host = contractHost(capabilities, { settings: twitchOnly({ tablessMode: false }) });
      const held = holdNewTabConfiguration(host);
      const ticking = host.controller.tickAndHandOff(["twitch"], "alarm");
      const tabId = await held.opened;

      const resetting = host.controller.prepareForHostReset();
      held.release();
      await Promise.all([ticking, resetting]);
      await host.settleTabEvents();

      expect(host.browser!.has(tabId)).toBe(false);
      host.controller.shutdown();
    });

    it("closes a watch tab it opened when the host resets before the tick commits it", async () => {
      const host = contractHost(capabilities, { settings: twitchOnly({ tablessMode: false }) });
      const open = vi.mocked(host.deps.openWatchTab!).getMockImplementation()!;
      const opened = deferred<number>();
      const release = deferred<void>();
      vi.mocked(host.deps.openWatchTab!).mockImplementationOnce(async (...args) => {
        const prepared = await open(...args);
        opened.resolve(prepared.tabId);
        await release.promise;
        return prepared;
      });
      const ticking = host.controller.tickAndHandOff(["twitch"], "alarm");
      const tabId = await opened.promise;

      const resetting = host.controller.prepareForHostReset();
      release.resolve();
      await Promise.all([ticking, resetting]);
      await host.settleTabEvents();

      expect(host.browser!.has(tabId)).toBe(false);
      host.controller.shutdown();
    });

    it("closes the watch tabs it left open when it restarts, without pausing", async () => {
      const host = contractHost(capabilities, { settings: twitchOnly({ tablessMode: false }) });
      const tabId = await watchInTab(host);

      const restarted = host.restart();
      await restarted.boot();
      await restarted.settleTabEvents();

      expect(restarted.browser!.has(tabId)).toBe(false);
      expect(restarted.storage.state.manualClosePause?.twitch).toBeUndefined();
      restarted.controller.shutdown();
    });
  });

  // #587: Twitch Extensions discovery runs as a tick effect with no lock held,
  // so a provider that never answers cannot hold up anything else.
  describe("blocked Twitch Extensions provider", () => {
    // Fails instead of hanging when the promise is held up.
    const within = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} waited on the blocked provider`)), 1_000);
      });
      try {
        return await Promise.race([promise, timeout]);
      } finally {
        clearTimeout(timer);
      }
    };

    it.runIf(capabilities.declared.supplementalSources)("delays neither Kick, a settings save nor shutdown", async () => {
      const host = contractHost(capabilities);
      // No drops on Twitch, so the tick asks the Twitch Extensions source,
      // which never answers until its tick is cancelled.
      vi.mocked(host.adapters.twitch.refreshCampaigns).mockResolvedValue([]);
      vi.mocked(host.deps.selectSupplementalWatchTarget!).mockImplementation((_platform, _state, _settings, signal) =>
        new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })));

      const twitchTick = host.controller.tickAndHandOff(["twitch"], "alarm");
      await vi.waitFor(() => expect(host.deps.selectSupplementalWatchTarget).toHaveBeenCalled());

      await within(host.controller.tickAndHandOff(["kick"], "alarm"), "A Kick tick");
      expect(host.storage.state.sessions.kick).toMatchObject({ status: "watching", campaignId: "kick-campaign" });
      await within(host.controller.handleMessage({ type: "saveSettings", settingsPatch: { pollIntervalMinutes: 7 } }), "A settings save");
      expect(host.storage.settings.pollIntervalMinutes).toBe(7);

      host.controller.shutdown();
      await within(twitchTick.catch(() => undefined), "Shutdown");
    });
  });

  // The push observer follows the state each tick commits, on every host
  // (#590): it is reconciled after the commit, with no lock held.
  describe("Twitch channel points", () => {
    it("starts the push observer after a tick that watches Twitch", async () => {
      const settings = twitchOnly();
      const host = contractHost(capabilities, {
        settings: {
          ...settings,
          platform: {
            ...settings.platform,
            twitch: { ...settings.platform.twitch, autoClaimChannelPoints: true, channelPointsPushClaim: true },
          },
        },
      });
      let starts = 0;
      host.adapters.twitch.createChannelPointsPushController = (() => ({
        subscribed: false,
        start: async () => {
          starts += 1;
        },
        stop: async () => undefined,
        drainEvents: () => [],
      })) as unknown as NonNullable<PlatformAdapter["createChannelPointsPushController"]>;

      await host.controller.tickAndHandOff(["twitch"], "alarm");

      expect(host.storage.state.sessions.twitch.status).toBe("watching");
      expect(starts).toBe(1);
      host.controller.shutdown();
    });
  });

  // Kick challenges belong to the Kick runtime (#588) on every host. The tick
  // claims them at its poll cadence. Only a host with tabs, where a manual
  // watch can pause the tick, schedules the ten-minute challenge job.
  describe("Kick challenges", () => {
    it(capabilities.declared.browserTabs
      ? "claims Kick challenges from the tick and schedules the challenge job"
      : "claims Kick challenges from the tick, with no challenge job", async () => {
      const host = contractHost(capabilities);
      host.adapters.kick.claimChallenges = vi.fn(async () => [{ id: "daily", rarity: "epic", recurrence: "daily" }]);
      await host.boot();

      await host.controller.tickAndHandOff(["kick"], "alarm");

      expect(host.adapters.kick.claimChallenges).toHaveBeenCalledOnce();
      expect(host.storage.state.gamification?.kick?.lastCheckedAt).toBeDefined();
      expect(host.reported).toContainEqual(expect.objectContaining({
        category: "activity",
        code: "challenge_claimed",
        platform: "kick",
      }));
      expect(host.jobs.scheduled.has(KICK_CHALLENGES_ALARM_NAME)).toBe(capabilities.declared.browserTabs);
      host.controller.shutdown();
    });
  });

  describe("runtime snapshot", () => {
    it("returns the stored settings and scheduler state as they are, which is all the popup reads", async () => {
      const host = contractHost(capabilities);
      await host.controller.tickAndHandOff(undefined, "alarm");
      const snapshot = await host.controller.handleMessage({ type: "getSnapshot" }) as RuntimeSnapshot;

      expect(Object.keys(snapshot).sort()).toEqual(["settings", "state"]);
      expect(snapshot.settings).toEqual(host.storage.settings);
      expect(snapshot.state).toEqual(host.storage.state);
      for (const platform of ["twitch", "kick"] as const) {
        expect(snapshot.state.sessions[platform]).toMatchObject({ platform, status: "watching", campaignId: `${platform}-campaign` });
        expect(snapshot.state.authHealth[platform].status).toBe("healthy");
      }
      host.controller.shutdown();
    });
  });
});
