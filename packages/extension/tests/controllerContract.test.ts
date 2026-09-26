import { afterEach, describe, expect, it, vi } from "vitest";
import { TWITCH_CHANNEL_POINTS_ALARM_NAME } from "@lurkloot/core/controller";
import type { DropCampaign, SchedulerState, WatchSession } from "@lurkloot/shared/models";
import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import {
  CAPABILITY_SETS,
  contractCampaign,
  contractChannel,
  contractHost,
  deferred,
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

  describe("process restart", () => {
    // Current behavior, not intended: #593 gives the CLI the same startup path.
    it(capabilities.runsStartup
      ? "pauses sessions left watching by the previous process, as a runtime restart"
      : "leaves sessions left watching by the previous process untouched until its own ticks and heartbeats reconcile them", async () => {
      const previous = contractHost(capabilities, { state: watchingState() });
      const restarted = previous.restart();
      // Only the restart's own cleanup is under test here, not the farming it
      // resumes, so the first tick's discovery stays blocked.
      const discovery = deferred<DropCampaign[]>();
      vi.mocked(restarted.adapters.twitch.refreshCampaigns).mockReturnValue(discovery.promise);
      vi.mocked(restarted.adapters.kick.refreshCampaigns).mockReturnValue(discovery.promise);

      const boot = restarted.boot();
      if (capabilities.runsStartup) {
        await vi.waitFor(() => expect(restarted.savedStates.length).toBeGreaterThan(0));
        const cleaned = restarted.savedStates[0];
        for (const platform of ["twitch", "kick"] as const) {
          expect(cleaned.sessions[platform]).toMatchObject({ status: "paused", reasonCode: "runtime_restart" });
          expect(cleaned.sessions[platform].channel).toBeUndefined();
        }
      } else {
        await boot;
        expect(restarted.savedStates).toHaveLength(0);
        expect(restarted.storage.state.sessions.twitch).toMatchObject({ status: "watching", campaignId: "twitch-campaign" });
        expect(restarted.storage.state.sessions.kick).toMatchObject({ status: "watching", campaignId: "kick-campaign" });
      }

      restarted.controller.shutdown();
      discovery.resolve([]);
      await Promise.allSettled([boot]);
    });
  });

  describe("jobs", () => {
    // Current behavior, not intended: #593 gives both hosts the same job set,
    // and #590 enables the CLI's one-minute channel-points job.
    it(capabilities.jobs
      ? "registers the one-minute Twitch channel-points job at startup"
      : "registers no jobs; the host's own intervals drive ticks and heartbeats only", async () => {
      const host = contractHost(capabilities);
      vi.mocked(host.adapters.twitch.refreshCampaigns).mockResolvedValue([]);
      vi.mocked(host.adapters.kick.refreshCampaigns).mockResolvedValue([]);
      await host.boot();
      await host.controller.tickAndHandOff(undefined, "alarm");
      if (capabilities.jobs) {
        expect(host.createdJobs).toContain(TWITCH_CHANNEL_POINTS_ALARM_NAME);
      } else {
        expect(host.createdJobs).toEqual([]);
      }
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
