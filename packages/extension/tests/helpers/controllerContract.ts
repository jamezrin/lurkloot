import { vi } from "vitest";
import { createBackgroundController, type BackgroundControllerDeps } from "@lurkloot/core/controller";
import { resolveCompatibility } from "@lurkloot/core";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { TablessWatchController } from "@lurkloot/core/tablessWatch";
import { forgetManagedPageContextTabs } from "@lurkloot/core/tabs";
import type { ChannelCandidate, DropCampaign, ExtensionSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import type { EngineEvent } from "@lurkloot/shared/events";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "../../src/core/storage";
import { withLockTracker } from "./lockTracker";

// Builds a background controller the way each host does today, so contract
// tests run once per declared capability set instead of once per host (#584).
// #593 turns these descriptions into the typed host ports and reuses the tests.
export interface CapabilitySet {
  readonly name: "extension" | "cli";
  // Watch tabs, page contexts and ad focus (#598).
  readonly browserTabs: boolean;
  // Real job scheduling. The CLI's createAlarm is a no-op, and it drives only
  // ticks and heartbeats from its own intervals (#593).
  readonly jobs: boolean;
  // Settings writes persist. The CLI reads a config file and never writes it.
  readonly persistsSettings: boolean;
  // The host calls handleStartup when its process starts. The CLI does not
  // (#593 gives both hosts one startup path).
  readonly runsStartup: boolean;
}

export const EXTENSION_CAPABILITIES: CapabilitySet = {
  name: "extension",
  browserTabs: true,
  jobs: true,
  persistsSettings: true,
  runsStartup: true,
};

// Mirrors the deps packages/cli/src/runtime/run.ts passes today.
export const CLI_CAPABILITIES: CapabilitySet = {
  name: "cli",
  browserTabs: false,
  jobs: false,
  persistsSettings: false,
  runsStartup: false,
};

export const CAPABILITY_SETS: readonly CapabilitySet[] = [EXTENSION_CAPABILITIES, CLI_CAPABILITIES];

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

export const contractCampaign = (platform: Platform): DropCampaign => ({
  id: `${platform}-campaign`,
  platform,
  name: `${platform} campaign`,
  status: "active",
  rewards: [{ id: `${platform}-reward`, name: "Reward", requiredMinutes: 60, watchedMinutes: 10, status: "in_progress" }],
});

export const contractChannel = (platform: Platform): ChannelCandidate => ({
  platform,
  username: `${platform}-creator`,
  url: platform === "twitch" ? "https://www.twitch.tv/twitch-creator" : "https://kick.com/kick-creator",
  live: true,
});

export function idleState(): SchedulerState {
  return {
    ...DEFAULT_STATE,
    sessions: {
      twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
      kick: { platform: "kick", status: "idle", offlineChecks: 0 },
    },
  };
}

export function farmingSettings(): ExtensionSettings {
  return {
    ...DEFAULT_SETTINGS,
    tablessMode: true,
    platform: {
      ...DEFAULT_SETTINGS.platform,
      twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
      kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: true },
    },
  };
}

class ContractWatcher implements TablessWatchController {
  channelUrl: string | undefined;
  constructor(readonly platform: Platform) {}
  async start(channel: ChannelCandidate): Promise<void> {
    this.channelUrl = channel.url;
  }
  async tick() {
    return { ok: true, live: true };
  }
  drainEvents() {
    return [];
  }
  async stop(): Promise<void> {
    this.channelUrl = undefined;
  }
}

function contractAdapter(platform: Platform, capabilities: CapabilitySet): PlatformAdapter {
  return {
    platform,
    supportsTabless: true,
    createTablessWatcher: () => new ContractWatcher(platform),
    checkAuthHealth: vi.fn(async () => ({ status: "healthy" as const })),
    refreshCampaigns: vi.fn(async () => [contractCampaign(platform)]),
    listCandidateChannels: vi.fn(async () => [contractChannel(platform)]),
    checkChannel: vi.fn(async (candidate: ChannelCandidate) => ({ live: true, categoryMatches: true, candidate })),
    claimReward: vi.fn(async () => true),
    // The CLI injects a watch-tab port that throws on open.
    prepareWatchTab: vi.fn(async () => {
      if (!capabilities.browserTabs) throw new Error("This host has no browser tabs");
      return { tabId: platform === "twitch" ? 10 : 20, managedByExtension: true };
    }),
    stopWatchTab: vi.fn(async () => undefined),
  };
}

export interface ContractStorage {
  settings: ExtensionSettings;
  state: SchedulerState;
}

export interface ContractHostOptions {
  readonly settings?: ExtensionSettings;
  readonly state?: SchedulerState;
  // Shared storage, so a restarted host sees what the previous one saved.
  readonly storage?: ContractStorage;
}

export interface ContractHost {
  readonly capabilities: CapabilitySet;
  readonly controller: ReturnType<typeof createBackgroundController<ExtensionSettings>>;
  readonly deps: BackgroundControllerDeps<ExtensionSettings>;
  readonly adapters: Record<Platform, PlatformAdapter>;
  readonly storage: ContractStorage;
  // Every state the controller saved, in order.
  readonly savedStates: SchedulerState[];
  // Every event reported to the host, in order.
  readonly reported: EngineEvent[];
  // Job names registered through a host that really schedules jobs.
  readonly createdJobs: string[];
  // What the host does when its process starts: the extension's service worker
  // calls handleStartup; the CLI goes straight to its loops.
  boot(): Promise<void>;
  // A new process over the same storage, with fresh in-memory state.
  restart(): ContractHost;
}

export function contractHost(capabilities: CapabilitySet, options: ContractHostOptions = {}): ContractHost {
  const storage: ContractStorage = options.storage ?? {
    settings: options.settings ?? farmingSettings(),
    state: options.state ?? idleState(),
  };
  const adapters: Record<Platform, PlatformAdapter> = {
    twitch: contractAdapter("twitch", capabilities),
    kick: contractAdapter("kick", capabilities),
  };
  const savedStates: SchedulerState[] = [];
  const reported: EngineEvent[] = [];
  const createdJobs: string[] = [];
  const compatibility = (settings: ExtensionSettings) =>
    resolveCompatibility(settings.compatibility, capabilities.browserTabs
      ? { host: "extension", twitchIdentity: "web" }
      : { host: "cli", twitchIdentity: "web" });

  const common: BackgroundControllerDeps<ExtensionSettings> = {
    loadSettings: vi.fn(async () => storage.settings),
    saveSettings: vi.fn(async (next: ExtensionSettings) => {
      if (capabilities.persistsSettings) storage.settings = next;
    }),
    loadState: vi.fn(async () => storage.state),
    saveState: vi.fn(async (next: SchedulerState) => {
      storage.state = next;
      savedStates.push(next);
    }),
    reportEvents: vi.fn(async (events: readonly EngineEvent[]) => {
      reported.push(...events);
    }),
    createAlarm: vi.fn(async (name: string) => {
      if (capabilities.jobs) createdJobs.push(name);
    }),
    createNotification: vi.fn(async () => undefined),
    createAdapters: vi.fn((_emit, settings: ExtensionSettings) => ({ adapters, ...compatibility(settings) })),
    createAdapter: vi.fn((platform: Platform, _emit, settings: ExtensionSettings) => ({ adapter: adapters[platform], ...compatibility(settings) })),
  };
  const deps: BackgroundControllerDeps<ExtensionSettings> = capabilities.browserTabs
    ? {
      ...common,
      getAlarm: vi.fn(async () => undefined),
      clearAlarm: vi.fn(async () => true),
      closeManagedTabs: vi.fn(async () => undefined),
      applyAdFocus: vi.fn(async () => undefined),
      loadTabPlaybackPolicy: vi.fn(async () => ({ keepVideosUnmuted: false })),
      stopPageContextTabs: vi.fn(forgetManagedPageContextTabs),
    }
    : common;

  const controller = createBackgroundController(withLockTracker(deps).deps);
  return {
    capabilities,
    controller,
    deps,
    adapters,
    storage,
    savedStates,
    reported,
    createdJobs,
    async boot(): Promise<void> {
      if (capabilities.runsStartup) await controller.handleStartup();
    },
    restart(): ContractHost {
      controller.shutdown();
      return contractHost(capabilities, { storage });
    },
  };
}
