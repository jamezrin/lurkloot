import { vi } from "vitest";
import {
  createBackgroundController,
  type BackgroundControllerDeps,
  type CredentialAvailability,
} from "@lurkloot/core/controller";
import { resolveCompatibility } from "@lurkloot/core";
import { heartbeatContextKey } from "@lurkloot/core/heartbeatCadence";
import type {
  ChannelCandidate,
  DropCampaign,
  DropReward,
  ExtensionSettings,
  Platform,
  SchedulerState,
  WatchSession,
} from "@lurkloot/shared/models";
import type { DiagnosticEvent, EngineEvent, EventEmitter } from "@lurkloot/shared/events";
import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import { applySettingsPatch, DEFAULT_SETTINGS } from "@lurkloot/shared/settings";
import { DEFAULT_STATE } from "../../src/core/storage";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import { withLockTracker } from "./lockTracker";
import type { TablessWatchController } from "@lurkloot/core/tablessWatch";
import type { StopPageContextTabs } from "@lurkloot/core/scheduler";
import { forgetManagedPageContextTabs, type TwitchIntegrityRequest } from "@lurkloot/core/tabs";
import type { IntegrityHeader, TwitchIntegrity } from "@lurkloot/core/twitchIntegrity";
import type { DiscoverySignalController, DiscoverySignalTarget } from "@lurkloot/core/discoverySignals";
import type { TwitchChannelPointsClaimNotice } from "@lurkloot/core/twitch/channelPointsPush";

// Fixtures and fakes shared by the background controller tests in
// tests/backgroundController/, which are split by the owner module each one
// exercises (#592).

export const reward = (status: DropReward["status"] = "in_progress"): DropReward => ({
  id: "reward",
  name: "Reward",
  requiredMinutes: 60,
  watchedMinutes: 10,
  status,
});

export const campaign = (platform: Platform, rewardStatus: DropReward["status"] = "in_progress"): DropCampaign => ({
  id: `${platform}-campaign`,
  platform,
  name: `${platform} campaign`,
  status: "active",
  rewards: [reward(rewardStatus)],
});

export const channel = (platform: Platform, patch: Partial<ChannelCandidate> = {}): ChannelCandidate => ({
  platform,
  username: `${platform}-creator`,
  url: platform === "twitch" ? "https://www.twitch.tv/twitch-creator" : "https://kick.com/kick-creator",
  ...patch,
});

export class FakeDiscoverySignalController implements DiscoverySignalController {
  readonly platform: Platform;
  targetKey: string | undefined;
  starts: DiscoverySignalTarget[] = [];
  stops = 0;
  private onSignal?: () => void;
  private readonly capturedSignals: Array<() => void> = [];
  private readonly events: DiagnosticEvent[] = [];

  constructor(platform: Platform) {
    this.platform = platform;
  }

  async start(target: DiscoverySignalTarget, onSignal: () => void): Promise<void> {
    this.starts.push(target);
    this.targetKey = target.channel.categoryId;
    this.onSignal = onSignal;
    this.capturedSignals.push(onSignal);
  }

  emitSignal(): void {
    this.onSignal?.();
  }

  emitCapturedSignal(index = 0): void {
    this.capturedSignals[index]?.();
  }

  pushDiagnostic(message: string): void {
    this.events.push({ category: "diagnostic", platform: this.platform, level: "warn", message });
  }

  drainEvents(): DiagnosticEvent[] {
    return this.events.splice(0);
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.targetKey = undefined;
    this.onSignal = undefined;
  }
}

export class FakeChannelPointsPushController {
  subscribed = false;
  starts = 0;
  stops = 0;
  startBarrier?: Promise<void>;
  startError?: Error;
  private onClaimAvailable?: (notice: TwitchChannelPointsClaimNotice) => void;
  private readonly events: DiagnosticEvent[] = [];

  async start(onClaimAvailable: (notice: TwitchChannelPointsClaimNotice) => void): Promise<void> {
    this.starts += 1;
    if (this.startError) {
      const error = this.startError;
      this.startError = undefined;
      throw error;
    }
    if (this.startBarrier) await this.startBarrier;
    this.onClaimAvailable = onClaimAvailable;
  }

  emitClaim(notice: TwitchChannelPointsClaimNotice): void {
    this.onClaimAvailable?.(notice);
  }

  pushDiagnostic(message: string): void {
    this.events.push({ category: "diagnostic", platform: "twitch", level: "warn", message });
  }

  drainEvents(): DiagnosticEvent[] {
    return this.events.splice(0);
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.onClaimAvailable = undefined;
    this.subscribed = false;
  }
}

export function asSnapshot(value: unknown): RuntimeSnapshot {
  return value as RuntimeSnapshot;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

export function integrityBundle(overrides: Partial<TwitchIntegrity> = {}): TwitchIntegrity {
  return {
    integrity: "test-integrity-token",
    clientSessionId: "test-session",
    deviceId: "test-device",
    expiresAt: Date.now() + 30 * 60_000,
    ...overrides,
  };
}

export function integrityHeaders(integrity: TwitchIntegrity): IntegrityHeader[] {
  return [
    { name: "Client-Integrity", value: integrity.integrity },
    { name: "Client-Session-Id", value: integrity.clientSessionId },
    { name: "X-Device-Id", value: integrity.deviceId },
  ];
}

// `running: true` used to be what made a fixture farm; with the master switch
// gone, farming means the platform flags are on. DEFAULT_SETTINGS now ships them
// off (a fresh install sits idle), so fixtures opt in explicitly. Both wrappers
// apply last so they win over any platform block in the literal they wrap.
export function farming<T extends ExtensionSettings>(settings: T): T {
  return withPlatformsEnabled(settings, true);
}

export function notFarming<T extends ExtensionSettings>(settings: T): T {
  return withPlatformsEnabled(settings, false);
}

export function withPlatformsEnabled<T extends ExtensionSettings>(settings: T, enabled: boolean): T {
  return {
    ...settings,
    platform: {
      ...settings.platform,
      twitch: { ...settings.platform.twitch, enabled },
      kick: { ...settings.platform.kick, enabled },
    },
  };
}

export function adapter(platform: Platform): PlatformAdapter {
  return {
    platform,
    checkAuthHealth: vi.fn(async () => ({ status: "healthy" as const })),
    refreshCampaigns: vi.fn(async () => [campaign(platform)]),
    listCandidateChannels: vi.fn(async () => [channel(platform)]),
    checkChannel: vi.fn(async (candidate) => ({ live: true, categoryMatches: true, candidate })),
    claimReward: vi.fn(async () => true),
    prepareWatchTab: vi.fn(async () => ({ tabId: platform === "twitch" ? 10 : 20, managedByExtension: true })),
    stopWatchTab: vi.fn(async () => undefined),
  };
}

export function twitchOperation(init?: RequestInit): string {
  return JSON.parse(String(init?.body)).operationName;
}

export function twitchInventory(): unknown {
  return {
    data: {
      currentUser: {
        id: "user-id",
        inventory: { dropCampaignsInProgress: [] },
      },
    },
  };
}

export function twitchDashboard(campaignIds: string[]): unknown {
  return {
    data: {
      currentUser: {
        id: "user-id",
        login: "viewer",
        dropCampaigns: campaignIds.map((id) => ({ id, status: "ACTIVE", self: { isAccountConnected: true } })),
      },
    },
  };
}

export function twitchCampaignDetails(dropID: string): unknown {
  return {
    data: {
      dropCampaign: {
        id: dropID,
        name: `Campaign ${dropID}`,
        game: { id: "game", slug: "game-slug", displayName: "Game" },
        timeBasedDrops: [{
          id: `${dropID}-drop`,
          requiredMinutesWatched: 60,
          benefitEdges: [{ benefit: { id: "benefit", name: "Reward" } }],
        }],
      },
    },
  };
}

export function harness(
  settings: ExtensionSettings = farming(DEFAULT_SETTINGS),
  overrides: {
    saveState?: (state: SchedulerState) => Promise<void>;
    reportEvents?: (events: readonly EngineEvent[]) => Promise<void>;
    stopPageContextTabs?: StopPageContextTabs;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    checkCredentialAvailability?: (platform: Platform) => Promise<CredentialAvailability>;
    authProbeTimeoutMs?: number;
    loadTwitchIntegrity?: () => Promise<TwitchIntegrity | undefined>;
    saveTwitchIntegrity?: (value: TwitchIntegrity) => Promise<void>;
    saveSettings?: (value: ExtensionSettings) => Promise<void>;
    createAlarm?: (
      name: string,
      options: { periodInMinutes: number } | { when: number },
    ) => Promise<void>;
    getAlarm?: (name: string) => Promise<{ scheduledTime: number } | undefined>;
    clearAlarm?: (name: string) => Promise<boolean>;
    ensureTwitchIntegrity?: (
      emit: EventEmitter,
      request?: TwitchIntegrityRequest,
    ) => Promise<boolean>;
    cancelTwitchIntegrityAcquisition?: (reason?: unknown) => void;
    selectWatchTarget?: BackgroundControllerDeps<ExtensionSettings>["selectWatchTarget"];
    reconcilePageContextRecovery?: BackgroundControllerDeps<ExtensionSettings>["reconcilePageContextRecovery"];
    discardPageContextRecoveryEvidence?: BackgroundControllerDeps<ExtensionSettings>["discardPageContextRecoveryEvidence"];
    initialState?: SchedulerState;
  } = {},
) {
  let currentSettings = settings;
  let currentState: SchedulerState = overrides.initialState ?? {
    ...DEFAULT_STATE,
    sessions: {
      twitch: { platform: "twitch", status: "idle", offlineChecks: 0 },
      kick: { platform: "kick", status: "idle", offlineChecks: 0 },
    },
  };
  const twitch = adapter("twitch");
  const kick = adapter("kick");
  const discoverySignalController = new FakeDiscoverySignalController("kick");
  const discoverySignalFactory = vi.fn(() => discoverySignalController);
  kick.createDiscoverySignalController = discoverySignalFactory;
  const channelPointsPushController = new FakeChannelPointsPushController();
  const channelPointsPushFactory = vi.fn(() => channelPointsPushController);
  twitch.createChannelPointsPushController = channelPointsPushFactory as unknown as PlatformAdapter["createChannelPointsPushController"];
  const reportEvents = vi.fn<(events: readonly EngineEvent[]) => Promise<void>>(async () => undefined);
  const deps = {
    loadSettings: vi.fn(async () => currentSettings),
    saveSettings: vi.fn(async (next: ExtensionSettings) => {
      await overrides.saveSettings?.(next);
      currentSettings = next;
    }),
    loadState: vi.fn(async () => currentState),
    saveState: vi.fn(overrides.saveState ?? (async (next: SchedulerState) => {
      currentState = next;
    })),
    createAlarm: vi.fn(overrides.createAlarm ?? (async (
      _name: string,
      _options: { periodInMinutes: number } | { when: number },
    ) => undefined)),
    getAlarm: vi.fn(overrides.getAlarm ?? (async () => undefined)),
    clearAlarm: vi.fn(overrides.clearAlarm ?? (async () => true)),
    ensureTwitchIntegrity: vi.fn(overrides.ensureTwitchIntegrity ?? (async () => true)),
    cancelTwitchIntegrityAcquisition: vi.fn(overrides.cancelTwitchIntegrityAcquisition ?? (() => undefined)),
    createNotification: vi.fn(async () => undefined),
    closeManagedTabs: vi.fn(async () => undefined),
    applyAdFocus: vi.fn<(platform: Platform, tabId: number | undefined, adActive: boolean, emit: EventEmitter) => Promise<void>>(async () => undefined),
    // Host-owned tab policy + settings-patch application (see background.ts).
    loadTabPlaybackPolicy: vi.fn(async () => ({ keepVideosUnmuted: currentSettings.keepFarmingVideosUnmuted !== false })),
    applySettingsPatch: vi.fn((current: ExtensionSettings, patch) => applySettingsPatch(current, patch)),
    createAdapters: vi.fn((_emit: EventEmitter, nextSettings: ExtensionSettings) => ({
      adapters: { twitch, kick },
      ...resolveCompatibility(nextSettings.compatibility, { host: "extension", twitchIdentity: "web" }),
    })),
    createAdapter: vi.fn((platform: Platform, _emit: EventEmitter, nextSettings: ExtensionSettings) => ({
      adapter: platform === "twitch" ? twitch : kick,
      ...resolveCompatibility(nextSettings.compatibility, { host: "extension", twitchIdentity: "web" }),
    })),
    reportEvents: vi.fn(overrides.reportEvents ?? reportEvents),
    stopPageContextTabs: vi.fn(overrides.stopPageContextTabs ?? forgetManagedPageContextTabs),
    ...(overrides.reconcilePageContextRecovery
      ? { reconcilePageContextRecovery: vi.fn(overrides.reconcilePageContextRecovery) }
      : {}),
    ...(overrides.discardPageContextRecoveryEvidence
      ? { discardPageContextRecoveryEvidence: vi.fn(overrides.discardPageContextRecoveryEvidence) }
      : {}),
    ...(overrides.selectWatchTarget ? { selectWatchTarget: vi.fn(overrides.selectWatchTarget) } : {}),
    wait: overrides.wait,
    ...(overrides.checkCredentialAvailability
      ? { checkCredentialAvailability: vi.fn(overrides.checkCredentialAvailability) }
      : {}),
    ...(overrides.authProbeTimeoutMs === undefined
      ? {}
      : { authProbeTimeoutMs: overrides.authProbeTimeoutMs }),
    ...(overrides.loadTwitchIntegrity
      ? { loadTwitchIntegrity: vi.fn(overrides.loadTwitchIntegrity) }
      : {}),
    ...(overrides.saveTwitchIntegrity
      ? { saveTwitchIntegrity: vi.fn(overrides.saveTwitchIntegrity) }
      : {}),
  };

  const { deps: trackedDeps, tracker: lockTracker } = withLockTracker(deps);
  const controller = createBackgroundController(trackedDeps);
  // User-action messages dispatch their scheduler tick in the background and
  // return the snapshot immediately, so the popup is never held open for a
  // network-bound tick. Tests here assert on what the tick produced, so the
  // harness settles that work before handing control back — keeping every
  // assertion about tick behavior meaningful. Tests that specifically exercise
  // the detachment use `rawHandleMessage`.
  const rawHandleMessage = controller.handleMessage;
  const handleMessage: typeof rawHandleMessage = async (message, sender) => {
    const result = await rawHandleMessage(message, sender);
    await controller.settleBackgroundWork();
    return result;
  };

  return {
    controller: { ...controller, handleMessage },
    rawController: controller,
    deps,
    lockTracker,
    get settings() {
      return currentSettings;
    },
    get state() {
      return currentState;
    },
    twitch,
    kick,
    discoverySignalController,
    discoverySignalFactory,
    channelPointsPushController,
    channelPointsPushFactory,
    reportEvents: deps.reportEvents,
  };
}

export function allDiagnostics(env: ReturnType<typeof harness>): DiagnosticEvent[] {
  return env.reportEvents.mock.calls
    .flatMap(([events]) => events)
    .filter((event): event is DiagnosticEvent => event.category === "diagnostic");
}

export function aggregateHeartbeatDiagnostics(
  env: ReturnType<typeof harness>,
  platform: Platform,
): string[] {
  return allDiagnostics(env)
    .filter((event) =>
      event.platform === platform
      && event.message.startsWith("Tabless heartbeat timing "))
    .map((event) => event.message);
}

export function lastAggregateDiagnostic(
  env: ReturnType<typeof harness>,
  platform: Platform,
): string | undefined {
  return aggregateHeartbeatDiagnostics(env, platform).at(-1);
}

export function dueHeartbeatCadence(session: WatchSession, dueAt = Date.now()) {
  const contextKey = heartbeatContextKey(session);
  if (!contextKey) throw new Error("Expected a complete tabless heartbeat context");
  return {
    generation: 1,
    contextKey,
    nextDueAt: new Date(dueAt).toISOString(),
  };
}

export function fakeTablessWatcher(
  tick: () => Promise<{ ok: boolean; live?: boolean; message?: string }>,
  platform: Platform = "twitch",
) {
  const watcher = {
    platform,
    channelUrl: undefined as string | undefined,
    start: vi.fn(async (ch: { url: string }) => {
      watcher.channelUrl = ch.url;
    }),
    tick: vi.fn(tick),
    drainEvents: vi.fn<() => DiagnosticEvent[]>(() => []),
    stop: vi.fn(async () => {
      watcher.channelUrl = undefined;
    }),
  };
  return watcher;
}

export function advanceToNextHeartbeatDue(): void {
  const nextDueAt = Date.now() + 60_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(nextDueAt);
}

// Drains every pending microtask. setTimeout stays real under the Date-only
// fake timers these handoff tests install, so one turn of the macrotask queue
// is enough to let an async loop run to its next park.
export const drainMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// A `wait` the test releases by hand, so handoff loops advance
// deterministically instead of racing real timers.
export function manualWait() {
  const pending: Array<() => void> = [];
  const wait = vi.fn(async (ms: number, signal: AbortSignal) => {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      pending.push(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    // The delay still consumes the handoff's time budget, so a loop driven
    // entirely by flush() still reaches its deadline.
    vi.setSystemTime(Date.now() + ms);
  });
  // Drain FIRST so the loop has actually parked — runClaimHandoff suspends on
  // loadSettings well before it reaches its first wait, and releasing an empty
  // queue would leave it parked forever.
  const flush = async () => {
    await drainMicrotasks();
    for (const resolve of pending.splice(0)) resolve();
    await drainMicrotasks();
  };
  return { wait, flush, get parked() { return pending.length; } };
}

export function tablessEnv(overrides: Partial<ExtensionSettings> = {}) {
  const env = harness({
    ...DEFAULT_SETTINGS,
    tablessMode: true,
    platform: {
      ...DEFAULT_SETTINGS.platform,
      twitch: { ...DEFAULT_SETTINGS.platform.twitch, enabled: true },
      kick: { ...DEFAULT_SETTINGS.platform.kick, enabled: false, idleWatchlistChannels: [] },
    },
    ...overrides,
  });
  env.twitch.supportsTabless = true;
  return env;
}

export async function establishedTablessEnv(platform: Platform) {
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
  const watcher = fakeTablessWatcher(async () => ({ ok: true, live: true }), platform);
  const adapter = platform === "twitch" ? env.twitch : env.kick;
  adapter.supportsTabless = true;
  adapter.createTablessWatcher = () => watcher as unknown as TablessWatchController;
  await env.controller.tick([platform]);
  advanceToNextHeartbeatDue();
  return { env, adapter, watcher };
}
