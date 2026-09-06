import { vi } from "vitest";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import { createBackgroundController } from "@lurkloot/core/controller";
import { resolveCompatibility } from "@lurkloot/core";
import type { EngineEvent, EventEmitter } from "@lurkloot/shared/events";
import type { ChannelCandidate, DropCampaign, ExtensionSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "../../src/core/storage";

export interface TickBaselineCounts {
  // Calls across the PlatformAdapter boundary. These are not transport request
  // counts: one adapter operation may issue zero, one, or several HTTP requests.
  adapterOperations: number;
  campaignDiscovery: number;
  candidateListings: number;
  channelChecks: number;
  campaignsEvaluated: number;
  candidatesEvaluated: number;
  watcherReconciliations: number;
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
  observedControllerMs?: Partial<Record<"discovery" | "selection" | "total", number>>;
}

export interface HostTickBaselineResult extends TickBaselineResult {
  host: "extension" | "cli";
  platform: Platform;
  scenario: TickBaselineScenario;
  outcomeCampaignId?: string;
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
  "adapterOperations",
  "campaignDiscovery",
  "candidateListings",
  "channelChecks",
  "campaignsEvaluated",
  "candidatesEvaluated",
  "watcherReconciliations",
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
  const campaign = baselineCampaign(platform);
  const urgentCampaign = baselineCampaign(platform, "urgent");
  const candidate = baselineCandidate(platform);
  const request = async (phase: "discovery" | "selection", milliseconds: number): Promise<void> => {
    recorder.count("adapterOperations");
    await recorder.clock.advance(phase, scenario === "slow" ? milliseconds * 10 : milliseconds);
  };

  return {
    platform,
    checkAuthHealth: async () => {
      recorder.count("adapterOperations");
      return { status: "healthy" };
    },
    refreshCampaigns: async () => {
      recorder.count("campaignDiscovery");
      await request("discovery", 30);
      if (scenario === "failed") throw new Error(`${platform} synthetic discovery failure`);
      return scenario === "idle"
        ? []
        : scenario === "higherPriorityUnavailable" ? [campaign, urgentCampaign] : [campaign];
    },
    listCandidateChannels: async (selectedCampaign) => {
      recorder.count("candidateListings");
      await request("selection", 10);
      return [{
        ...candidate,
        username: selectedCampaign.id.endsWith("urgent") ? `${platform}-urgent-creator` : candidate.username,
      }];
    },
    checkChannel: async (checkedCandidate) => {
      recorder.count("channelChecks");
      await request("selection", 10);
      return {
        live: scenario !== "higherPriorityUnavailable" || !checkedCandidate.username.includes("urgent"),
        categoryMatches: true,
        candidate: checkedCandidate,
      };
    },
    claimReward: async () => false,
    prepareWatchTab: async () => {
      recorder.count("watcherReconciliations");
      await recorder.clock.advance("watcher", 5);
      return {
        tabId: platform === "twitch" ? 10 : 20,
        managedByExtension: true,
      };
    },
    stopWatchTab: async () => undefined,
  };
}

function baselineCampaign(platform: Platform, suffix = "campaign"): DropCampaign {
  return {
    id: `${platform}-${suffix}`,
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
}

function baselineCandidate(platform: Platform): ChannelCandidate {
  return {
    platform,
    username: `${platform}-creator`,
    displayName: `${platform} creator`,
    url: platform === "twitch"
      ? "https://www.twitch.tv/twitch-creator"
      : "https://kick.com/kick-creator",
  };
}

export async function runExtensionBaselineCell(
  platform: Platform,
  scenario: TickBaselineScenario,
): Promise<HostTickBaselineResult> {
  const recorder = createTickBaselineRecorder();
  const adapters = {
    twitch: createCountingAdapter("twitch", platform === "twitch" ? scenario : "idle", recorder),
    kick: createCountingAdapter("kick", platform === "kick" ? scenario : "idle", recorder),
  } satisfies Record<Platform, PlatformAdapter>;
  const settings: ExtensionSettings = {
    ...DEFAULT_SETTINGS,
    platform: {
      twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: platform === "twitch" },
      kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: platform === "kick" },
    },
    campaignPriorities: scenario === "higherPriorityUnavailable"
      ? { [`${platform}-urgent`]: 10 }
      : {},
  };
  let state: SchedulerState = structuredClone(DEFAULT_STATE);
  if (scenario === "stable" || scenario === "retained" || scenario === "switch" || scenario === "higherPriorityUnavailable") {
    const currentIds = scenario === "switch"
      ? { campaign: `${platform}-old-campaign`, reward: `${platform}-old-reward` }
      : { campaign: `${platform}-campaign`, reward: `${platform}-reward` };
    const candidate = scenario === "switch"
      ? {
          ...baselineCandidate(platform),
          username: `${platform}-old-creator`,
          url: platform === "twitch"
            ? "https://www.twitch.tv/twitch-old-creator"
            : "https://kick.com/kick-old-creator",
        }
      : baselineCandidate(platform);
    const tabId = platform === "twitch" ? 10 : 20;
    const retainedCampaign = scenario === "switch"
      ? {
          ...baselineCampaign(platform),
          id: currentIds.campaign,
          rewards: [{
            ...baselineCampaign(platform).rewards[0],
            id: currentIds.reward,
          }],
        }
      : baselineCampaign(platform);
    state = {
      ...state,
      campaigns: { ...state.campaigns, [platform]: [retainedCampaign] },
      sessions: {
        ...state.sessions,
        [platform]: {
          platform,
          status: "watching",
          offlineChecks: 0,
          channel: candidate,
          campaignId: currentIds.campaign,
          rewardId: currentIds.reward,
          tabId,
          tabManagedByExtension: true,
          watchMode: "tab",
          startedAt: new Date().toISOString(),
          watchTabOpenedAt: new Date().toISOString(),
        },
      },
      managedWatchTabs: {
        ...state.managedWatchTabs,
        [platform]: {
          platform,
          tabId,
          channelUrl: candidate.url,
          ownedByExtension: true,
        },
      },
    };
  }
  const compatibility = resolveCompatibility(settings.compatibility, {
    host: "extension",
    twitchIdentity: "web",
  });
  const observedControllerMs: Partial<Record<"discovery" | "selection" | "total", number>> = {};
  const reportEvents = async (events: readonly EngineEvent[]): Promise<void> => {
    if (events.length === 0) return;
    recorder.count("eventPublications");
    for (const event of events) {
      if (event.category !== "diagnostic") continue;
      const refreshDuration = event.message.match(/^Campaign refresh finished in (\d+)ms/);
      if (refreshDuration) observedControllerMs.discovery = Number(refreshDuration[1]);
      const selectionDuration = event.message.match(/^Campaign selection(?: fast path retained current watch)? finished in (\d+)ms/);
      if (selectionDuration) observedControllerMs.selection = Number(selectionDuration[1]);
      const totalDuration = event.message.match(/^Tick #\d+ finished after (\d+)ms/);
      if (totalDuration) observedControllerMs.total = Number(totalDuration[1]);
      const selection = event.message.match(/\((\d+) campaigns? checked, (\d+) candidates? checked\)/);
      if (selection) {
        recorder.count("campaignsEvaluated", Number(selection[1]));
        recorder.count("candidatesEvaluated", Number(selection[2]));
      }
      if (/fast path retained current watch/.test(event.message)) {
        recorder.count("candidatesEvaluated");
      }
    }
  };
  const resolutionFor = (selectedPlatform: Platform) => {
    recorder.count("adapterConstructions");
    return { adapter: adapters[selectedPlatform], ...compatibility };
  };
  const controller = createBackgroundController<ExtensionSettings>({
    loadSettings: async () => {
      recorder.count("settingsLoads");
      return settings;
    },
    saveSettings: async () => undefined,
    loadState: async () => {
      recorder.count("stateLoads");
      return state;
    },
    saveState: async (next) => {
      recorder.count("stateSaves");
      await recorder.clock.advance("persistence", 5);
      state = next;
    },
    reportEvents,
    createAlarm: async () => undefined,
    ensureTwitchIntegrity: async () => true,
    createNotification: async () => undefined,
    createAdapter: (selectedPlatform) => resolutionFor(selectedPlatform),
    createAdapters: (_emit: EventEmitter) => {
      recorder.count("adapterConstructions", 2);
      return { adapters, ...compatibility };
    },
  });

  await controller.tickAndHandOff([platform], "alarm");
  return {
    host: "extension",
    platform,
    scenario,
    ...recorder.snapshot(),
    observedControllerMs,
    outcomeCampaignId: state.sessions[platform].campaignId,
  };
}
