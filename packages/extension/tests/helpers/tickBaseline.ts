import { vi } from "vitest";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { ChannelCandidate, DropCampaign, Platform } from "@lurkloot/shared/models";

export interface TickBaselineCounts {
  providerRequests: number;
  campaignDiscovery: number;
  candidateListings: number;
  channelChecks: number;
  campaignsEvaluated: number;
  candidatesEvaluated: number;
  watcherReconciliations: number;
  heartbeats: number;
  adapterConstructions: number;
  settingsLoads: number;
  stateLoads: number;
  stateSaves: number;
  eventPublications: number;
}

export type TickPhase = "discovery" | "selection" | "watcher" | "persistence" | "total";

export interface TickBaselineResult {
  counts: TickBaselineCounts;
  durationsMs: Record<TickPhase, number>;
}

export type TickBaselineScenario =
  | "idle"
  | "stable"
  | "refresh"
  | "retained"
  | "switch"
  | "higherPriorityUnavailable"
  | "slow"
  | "failed";

export type TickBaselineRecorder = ReturnType<typeof createTickBaselineRecorder>;

const countKeys = [
  "providerRequests",
  "campaignDiscovery",
  "candidateListings",
  "channelChecks",
  "campaignsEvaluated",
  "candidatesEvaluated",
  "watcherReconciliations",
  "heartbeats",
  "adapterConstructions",
  "settingsLoads",
  "stateLoads",
  "stateSaves",
  "eventPublications",
] as const satisfies readonly (keyof TickBaselineCounts)[];

export function createTickBaselineRecorder() {
  const counts = Object.fromEntries(countKeys.map((key) => [key, 0])) as unknown as TickBaselineCounts;
  const durationsMs: Record<TickPhase, number> = {
    discovery: 0,
    selection: 0,
    watcher: 0,
    persistence: 0,
    total: 0,
  };

  return {
    count(key: keyof TickBaselineCounts, amount = 1): void {
      counts[key] += amount;
    },
    clock: {
      async advance(phase: Exclude<TickPhase, "total">, milliseconds: number): Promise<void> {
        durationsMs[phase] += milliseconds;
        durationsMs.total += milliseconds;
        vi.setSystemTime(Date.now() + milliseconds);
        await Promise.resolve();
      },
      duration(phase: TickPhase): number {
        return durationsMs[phase];
      },
    },
    snapshot(): TickBaselineResult {
      return {
        counts: { ...counts },
        durationsMs: { ...durationsMs },
      };
    },
  };
}

export function createCountingAdapter(
  platform: Platform,
  scenario: TickBaselineScenario,
  recorder: TickBaselineRecorder,
): PlatformAdapter {
  const campaign: DropCampaign = {
    id: `${platform}-campaign`,
    platform,
    name: `${platform} campaign`,
    status: "active",
    rewards: [{
      id: `${platform}-reward`,
      name: `${platform} reward`,
      requiredMinutes: 60,
      watchedMinutes: 10,
      status: "in_progress",
    }],
  };
  const candidate: ChannelCandidate = {
    platform,
    username: `${platform}-creator`,
    displayName: `${platform} creator`,
    url: platform === "twitch"
      ? "https://www.twitch.tv/twitch-creator"
      : "https://kick.com/kick-creator",
  };
  const request = async (phase: "discovery" | "selection", milliseconds: number): Promise<void> => {
    recorder.count("providerRequests");
    await recorder.clock.advance(phase, scenario === "slow" ? milliseconds * 10 : milliseconds);
  };

  return {
    platform,
    checkAuthHealth: async () => ({ status: "healthy" }),
    refreshCampaigns: async () => {
      recorder.count("campaignDiscovery");
      await request("discovery", 30);
      if (scenario === "failed") throw new Error(`${platform} synthetic discovery failure`);
      return scenario === "idle" ? [] : [campaign];
    },
    listCandidateChannels: async () => {
      recorder.count("candidateListings");
      await request("selection", 10);
      return [candidate];
    },
    checkChannel: async (checkedCandidate) => {
      recorder.count("channelChecks");
      await request("selection", 10);
      return {
        live: scenario !== "higherPriorityUnavailable",
        categoryMatches: true,
        candidate: checkedCandidate,
      };
    },
    claimReward: async () => false,
    prepareWatchTab: async () => ({
      tabId: platform === "twitch" ? 10 : 20,
      managedByExtension: true,
    }),
    stopWatchTab: async () => undefined,
  };
}
