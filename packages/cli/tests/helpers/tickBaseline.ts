import { join } from "node:path";
import { vi } from "vitest";
import { resolveCompatibility } from "@lurkloot/core";
import { DEFAULT_STATE } from "@lurkloot/core/defaults";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { ChannelCandidate, DropCampaign, EngineSettings, Platform } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import { DEFAULT_CLI_SETTINGS, type CliSettings } from "../../src/settings";
import type { Logger } from "../../src/logger";
import { runLoop } from "../../src/runtime/run";
import { loadState, saveState } from "../../src/storage";
import type { TransportHandle } from "../../src/transport";

type Scenario = "idle" | "stable" | "switch" | "higherPriorityUnavailable" | "slow" | "failed";

interface Counts {
  // PlatformAdapter calls, not raw HTTP request counts.
  adapterOperations: number;
  campaignDiscovery: number;
  candidateListings: number;
  channelChecks: number;
  adapterConstructions: number;
  watcherReconciliations: number;
}

interface Durations {
  discovery: number;
  selection: number;
  watcher: number;
  persistence: number;
  total: number;
}

const silentLogger: Logger = {
  level: "error",
  log: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function countingAdapter(
  platform: Platform,
  scenario: Scenario,
  counts: Counts,
  advance: (phase: "discovery" | "selection" | "watcher", milliseconds: number) => void,
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
  const urgentCampaign: DropCampaign = {
    ...campaign,
    id: `${platform}-urgent`,
  };
  const candidate: ChannelCandidate = {
    platform,
    username: `${platform}-creator`,
    url: platform === "twitch"
      ? "https://www.twitch.tv/twitch-creator"
      : "https://kick.com/kick-creator",
  };
  const request = (): void => { counts.adapterOperations += 1; };
  return {
    platform,
    checkAuthHealth: async () => {
      request();
      return { status: "healthy" };
    },
    refreshCampaigns: async () => {
      counts.campaignDiscovery += 1;
      request();
      advance("discovery", scenario === "slow" ? 300 : 30);
      if (scenario === "failed") throw new Error(`${platform} synthetic discovery failure`);
      return scenario === "idle"
        ? []
        : scenario === "higherPriorityUnavailable" ? [campaign, urgentCampaign] : [campaign];
    },
    listCandidateChannels: async (selectedCampaign) => {
      counts.candidateListings += 1;
      request();
      advance("selection", scenario === "slow" ? 100 : 10);
      return [{
        ...candidate,
        username: selectedCampaign.id.endsWith("urgent") ? `${platform}-urgent-creator` : candidate.username,
      }];
    },
    checkChannel: async (checkedCandidate) => {
      counts.channelChecks += 1;
      request();
      advance("selection", scenario === "slow" ? 100 : 10);
      return {
        live: scenario !== "higherPriorityUnavailable" || !checkedCandidate.username.includes("urgent"),
        categoryMatches: true,
        candidate: checkedCandidate,
      };
    },
    claimReward: async () => false,
    prepareWatchTab: async () => {
      counts.watcherReconciliations += 1;
      advance("watcher", 5);
      return { tabId: platform === "twitch" ? 10 : 20, managedByExtension: false };
    },
    stopWatchTab: async () => undefined,
  };
}

export async function runCliBaselineCell(
  directory: string,
  platform: Platform,
  scenario: Scenario,
) {
  const counts: Counts = {
    adapterOperations: 0,
    campaignDiscovery: 0,
    candidateListings: 0,
    channelChecks: 0,
    adapterConstructions: 0,
    watcherReconciliations: 0,
  };
  const durationsMs: Durations = {
    discovery: 0,
    selection: 0,
    watcher: 0,
    persistence: 0,
    total: 0,
  };
  const advance = (phase: "discovery" | "selection" | "watcher" | "persistence", milliseconds: number): void => {
    durationsMs[phase] += milliseconds;
    durationsMs.total += milliseconds;
    vi.setSystemTime(Date.now() + milliseconds);
  };
  const adapters = {
    twitch: countingAdapter("twitch", platform === "twitch" ? scenario : "idle", counts, advance),
    kick: countingAdapter("kick", platform === "kick" ? scenario : "idle", counts, advance),
  } satisfies Record<Platform, PlatformAdapter>;
  const settings: CliSettings = {
    ...DEFAULT_CLI_SETTINGS,
    platform: {
      twitch: { ...DEFAULT_CLI_SETTINGS.platform.twitch, enabled: platform === "twitch" },
      kick: { ...DEFAULT_CLI_SETTINGS.platform.kick, enabled: platform === "kick" },
    },
    campaignPriorities: scenario === "higherPriorityUnavailable"
      ? { [`${platform}-urgent`]: 10 }
      : {},
  };
  const buildOne = (selectedPlatform: Platform, _emit: EventEmitter, engineSettings: EngineSettings) => {
    counts.adapterConstructions += 1;
    return {
      adapter: adapters[selectedPlatform],
      ...resolveCompatibility(engineSettings.compatibility, { host: "cli", twitchIdentity: "web" }),
    };
  };
  const transport: TransportHandle = {
    adapters,
    createAdapter: buildOne,
    createAdapters: (_emit, engineSettings) => {
      counts.adapterConstructions += 2;
      return {
        adapters,
        ...resolveCompatibility(engineSettings.compatibility, { host: "cli", twitchIdentity: "web" }),
      };
    },
    dispose: async () => undefined,
  };

  const statePath = join(directory, `${platform}-${scenario}.json`);
  if (scenario === "stable" || scenario === "switch" || scenario === "higherPriorityUnavailable") {
    const candidate: ChannelCandidate = {
      platform,
      username: `${platform}-creator`,
      url: platform === "twitch"
        ? "https://www.twitch.tv/twitch-creator"
        : "https://kick.com/kick-creator",
    };
    const current = scenario === "switch"
      ? countingCampaign(platform, "old-campaign", "old-reward")
      : countingCampaign(platform);
    await saveState(statePath, {
      ...structuredClone(DEFAULT_STATE),
      campaigns: { ...DEFAULT_STATE.campaigns, [platform]: [current] },
      sessions: {
        ...DEFAULT_STATE.sessions,
        [platform]: {
          platform,
          status: "watching",
          offlineChecks: 0,
          channel: candidate,
          campaignId: current.id,
          rewardId: current.rewards[0].id,
          watchMode: "tab",
          startedAt: new Date().toISOString(),
        },
      },
    });
  }

  await runLoop({
    settings,
    statePath,
    transport,
    logger: silentLogger,
    once: true,
  });
  const finalState = await loadState(statePath);

  return {
    host: "cli" as const,
    platform,
    scenario,
    counts,
    durationsMs,
    outcomeCampaignId: finalState.sessions[platform].campaignId,
  };
}

function countingCampaign(platform: Platform, campaignSuffix = "campaign", rewardSuffix = "reward"): DropCampaign {
  return {
    id: `${platform}-${campaignSuffix}`,
    platform,
    name: `${platform} campaign`,
    status: "active",
    rewards: [{
      id: `${platform}-${rewardSuffix}`,
      name: `${platform} reward`,
      requiredMinutes: 60,
      watchedMinutes: 10,
      status: "in_progress",
    }],
  };
}
