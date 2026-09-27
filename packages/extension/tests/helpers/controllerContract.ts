import { vi } from "vitest";
import {
  CLI_CAPABILITIES,
  createBackgroundController,
  EXTENSION_CAPABILITIES,
  type HostCapabilities,
  type JobSchedule,
} from "@lurkloot/core/controller";
import { resolveCompatibility } from "@lurkloot/core";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { TablessWatchController } from "@lurkloot/core/tablessWatch";
import { createTabRegistry } from "@lurkloot/core/tabRegistry";
import type { ChannelCandidate, DropCampaign, ExtensionSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import type { EngineEvent } from "@lurkloot/shared/events";
import { DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "../../src/core/storage";
import { createExtensionTabPorts } from "../../src/core/tabPorts";
import { FakeBrowser } from "./fakeBrowser";
import { withLockTracker } from "./lockTracker";
import { hostPortsFromMocks, type HostMocks } from "./hostPorts";

// Builds a background controller from the host ports each host passes (#593),
// so contract tests run once per declared capability set instead of once per
// host (#584).
export interface CapabilitySet {
  readonly name: "extension" | "cli";
  // What the host declares to the controller.
  readonly declared: HostCapabilities;
  // Settings writes persist. The CLI reads a config file and never writes it.
  readonly persistsSettings: boolean;
  // Both hosts run the shared restart reconciliation when their process starts
  // (#593). The extension's handleStartup then resumes farming itself; the
  // CLI calls reconcileStartup and resumes through its own tick driver.
  readonly resumesOnStartup: boolean;
}

export const EXTENSION_HOST: CapabilitySet = {
  name: "extension",
  declared: EXTENSION_CAPABILITIES,
  persistsSettings: true,
  resumesOnStartup: true,
};

// Mirrors the ports packages/cli/src/runtime/run.ts passes.
export const CLI_HOST: CapabilitySet = {
  name: "cli",
  declared: CLI_CAPABILITIES,
  persistsSettings: false,
  resumesOnStartup: false,
};

export const CAPABILITY_SETS: readonly CapabilitySet[] = [EXTENSION_HOST, CLI_HOST];

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
  username: `${platform}_creator`,
  url: platform === "twitch" ? "https://www.twitch.tv/twitch_creator" : "https://kick.com/kick_creator",
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

function contractAdapter(platform: Platform): PlatformAdapter {
  return {
    platform,
    supportsTabless: true,
    createTablessWatcher: () => new ContractWatcher(platform),
    checkAuthHealth: vi.fn(async () => ({ status: "healthy" as const })),
    refreshCampaigns: vi.fn(async () => [contractCampaign(platform)]),
    listCandidateChannels: vi.fn(async () => [contractChannel(platform)]),
    checkChannel: vi.fn(async (candidate: ChannelCandidate) => ({ live: true, categoryMatches: true, candidate })),
    claimReward: vi.fn(async () => true),
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
  // Shared tabs, which outlive a restart like storage does.
  readonly browser?: FakeBrowser;
}

export interface ContractHost {
  readonly capabilities: CapabilitySet;
  readonly controller: ReturnType<typeof createBackgroundController<ExtensionSettings>>;
  readonly deps: HostMocks<ExtensionSettings>;
  readonly adapters: Record<Platform, PlatformAdapter>;
  readonly storage: ContractStorage;
  // The browser behind the extension's real tab ports; absent without tabs.
  readonly browser?: FakeBrowser;
  // Waits until every tab event the browser fired has reached the controller
  // and the work it started has settled.
  settleTabEvents(): Promise<void>;
  // Every state the controller saved, in order.
  readonly savedStates: SchedulerState[];
  // Every event reported to the host, in order.
  readonly reported: EngineEvent[];
  // The host's job scheduler, as the controller left it.
  readonly jobs: FakeJobScheduler;
  // What the host does when its process starts: the extension calls
  // handleStartup; the CLI calls reconcileStartup.
  boot(): Promise<void>;
  // Delivers a fire of `name` the way the host's scheduler would.
  fire(name: string): Promise<void>;
  // A new process over the same storage, with fresh in-memory state.
  restart(): ContractHost;
}

// A job scheduler with the port's semantics and no clock: tests fire jobs by
// hand, and `ensured` records every schedule in order.
export class FakeJobScheduler {
  readonly scheduled = new Map<string, JobSchedule>();
  readonly ensured: string[] = [];
  readonly cancelled: string[] = [];
  async ensure(name: string, schedule: JobSchedule): Promise<void> {
    this.scheduled.set(name, schedule);
    this.ensured.push(name);
  }
  async cancel(name: string): Promise<boolean> {
    this.cancelled.push(name);
    return this.scheduled.delete(name);
  }
  async get(name: string): Promise<{ scheduledTime: number } | undefined> {
    const schedule = this.scheduled.get(name);
    if (!schedule) return undefined;
    return { scheduledTime: "when" in schedule ? schedule.when : Date.now() + schedule.periodInMinutes * 60_000 };
  }
}

export function contractHost(capabilities: CapabilitySet, options: ContractHostOptions = {}): ContractHost {
  const storage: ContractStorage = options.storage ?? {
    settings: options.settings ?? farmingSettings(),
    state: options.state ?? idleState(),
  };
  const adapters: Record<Platform, PlatformAdapter> = {
    twitch: contractAdapter("twitch"),
    kick: contractAdapter("kick"),
  };
  const savedStates: SchedulerState[] = [];
  const reported: EngineEvent[] = [];
  const jobs = new FakeJobScheduler();
  const compatibility = (settings: ExtensionSettings) =>
    resolveCompatibility(settings.compatibility, capabilities.declared.browserTabs
      ? { host: "extension", twitchIdentity: "web" }
      : { host: "cli", twitchIdentity: "web" });

  const common: HostMocks<ExtensionSettings> = {
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
    createAlarm: vi.fn((name: string, schedule: JobSchedule) => jobs.ensure(name, schedule)),
    getAlarm: vi.fn((name: string) => jobs.get(name)),
    clearAlarm: vi.fn((name: string) => jobs.cancel(name)),
    createNotification: vi.fn(async () => undefined),
    createAdapters: vi.fn((_emit, settings: ExtensionSettings) => ({ adapters, ...compatibility(settings) })),
    createAdapter: vi.fn((platform: Platform, _emit, settings: ExtensionSettings) => ({ adapter: adapters[platform], ...compatibility(settings) })),
  };
  // The extension runs its real tab ports against a fake browser (#598); each
  // port call still goes through a spy, so tests can assert on it and the lock
  // tracker still sees it. The ports read settings straight from storage rather
  // than through the loadSettings mock, as they do not belong to the controller.
  const tabRegistry = createTabRegistry();
  const browser = capabilities.declared.browserTabs ? options.browser ?? new FakeBrowser() : undefined;
  const tabs = browser ? createExtensionTabPorts(tabRegistry, browser, async () => storage.settings) : undefined;
  const deps: HostMocks<ExtensionSettings> = {
    ...common,
    ...(tabs
      ? {
        tabRegistry,
        openWatchTab: vi.fn(tabs.watch.open),
        stopWatchTab: vi.fn(tabs.watch.stop),
        closeManagedTabs: vi.fn(async (managed, origin = "extension-cleanup") => await tabs.watch.closeManaged(managed, origin)),
        applyAdFocus: vi.fn(tabs.watch.applyAdFocus),
        loadTabPlaybackPolicy: vi.fn(tabs.watch.loadPlaybackPolicy),
        stopPageContextTabs: vi.fn(tabs.pageContexts.release),
      }
      : {}),
    ...(capabilities.declared.twitchIntegrityCapture
      ? { ensureTwitchIntegrity: vi.fn(async () => true), cancelTwitchIntegrityAcquisition: vi.fn() }
      : {}),
    ...(capabilities.declared.supplementalSources
      ? { selectSupplementalWatchTarget: vi.fn(async () => undefined) }
      : {}),
  };

  const controller = createBackgroundController(hostPortsFromMocks(withLockTracker(deps).deps, capabilities.declared));
  // What background.ts does with tabs.onRemoved.
  const tabEvents = new Set<Promise<void>>();
  const unsubscribe = browser?.onRemoved((tabId) => {
    const handled = controller.handleTabRemoved(tabId).finally(() => tabEvents.delete(handled));
    tabEvents.add(handled);
  });
  return {
    capabilities,
    controller,
    deps,
    adapters,
    storage,
    browser,
    savedStates,
    reported,
    jobs,
    async boot(): Promise<void> {
      if (capabilities.resumesOnStartup) await controller.handleStartup();
      else await controller.reconcileStartup();
    },
    fire: (name) => controller.runJob(name),
    async settleTabEvents(): Promise<void> {
      // onRemoved fires on a later microtask than the removal, so yield once
      // before looking for handlers still in flight.
      await new Promise((resolve) => setTimeout(resolve, 0));
      while (tabEvents.size > 0) await Promise.all(tabEvents);
      await controller.settleBackgroundWork();
    },
    restart(): ContractHost {
      controller.shutdown();
      unsubscribe?.();
      return contractHost(capabilities, { storage, browser });
    },
  };
}
