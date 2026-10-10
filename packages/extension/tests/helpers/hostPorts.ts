import type {
  BackgroundHostPorts,
  CredentialAvailability,
  HostCapabilities,
  LockTracker,
  PageContextRecoveryOptions,
} from "@lurkloot/core/controller";
import type { PlatformAdapter } from "@lurkloot/core/adapter";
import type { StopPageContextTabs } from "@lurkloot/core/scheduler";
import type { TabRegistry, TwitchIntegrityRequest } from "@lurkloot/core/tabRegistry";
import type { TwitchIntegrity } from "@lurkloot/core/twitchIntegrity";
import type { CompatibilityResolution, ResolvedCompatibility } from "@lurkloot/shared/compatibility";
import type { EngineEvent, EventEmitter } from "@lurkloot/shared/events";
import type {
  ChannelCandidate,
  EngineSettings,
  ManagedWatchTab,
  Platform,
  PreparedWatchTab,
  SchedulerState,
  SupplementalWatchTarget,
  TabClosureOrigin,
  WatchSession,
  WatchSourceId,
  WatchTabOptions,
} from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";

// The controller tests keep one flat object of mocks, so a test can replace or
// inspect any host call by name (`env.deps.createAlarm`). hostPortsFromMocks
// groups them into the host ports the controller takes (#593). Each call goes
// through the flat object at call time, so the lock tracker's guarded proxy and
// mocks replaced after construction still apply.
export interface HostMocks<S extends EngineSettings> {
  loadSettings(): Promise<S>;
  saveSettings(settings: S): Promise<void>;
  loadState(): Promise<SchedulerState>;
  saveState(state: SchedulerState): Promise<void>;
  applySettingsPatch?(current: S, patch: SettingsPatch): S;
  reportEvents?(events: readonly EngineEvent[]): Promise<void>;
  createNotification?(notification: { title: string; message: string }): Promise<void>;
  translate?(key: string, substitutions?: string | string[]): string | Promise<string>;
  createAlarm(name: string, options: { periodInMinutes: number } | { when: number }): Promise<void>;
  getAlarm?(name: string): Promise<{ scheduledTime: number } | undefined>;
  clearAlarm?(name: string): Promise<boolean>;
  checkCredentialAvailability?(platform: Platform): Promise<CredentialAvailability>;
  createAdapters(emit: EventEmitter, settings: S): {
    adapters: Record<Platform, PlatformAdapter>;
    compatibility: ResolvedCompatibility;
    warnings: CompatibilityResolution["warnings"];
  };
  createAdapter(platform: Platform, emit: EventEmitter, settings: S): {
    adapter: PlatformAdapter;
    compatibility: ResolvedCompatibility;
    warnings: CompatibilityResolution["warnings"];
  };
  openWatchTab?(
    channel: ChannelCandidate,
    session: WatchSession | undefined,
    options: Partial<WatchTabOptions>,
    emit: EventEmitter,
  ): Promise<PreparedWatchTab>;
  stopWatchTab?(session: WatchSession, options: Partial<WatchTabOptions>, emit: EventEmitter): Promise<void>;
  closeManagedTabs?(tabs: ManagedWatchTab[], origin?: Exclude<TabClosureOrigin, "user">): Promise<void>;
  stopPageContextTabs?: StopPageContextTabs;
  applyAdFocus?(platform: Platform, tabId: number | undefined, adActive: boolean, emit: EventEmitter): Promise<void>;
  loadTabPlaybackPolicy?(): Promise<{ keepVideosUnmuted: boolean }>;
  ensureTwitchIntegrity?(emit: EventEmitter, request?: TwitchIntegrityRequest): Promise<boolean>;
  cancelTwitchIntegrityAcquisition?(reason?: unknown): void;
  loadTwitchIntegrity?(): Promise<TwitchIntegrity | undefined>;
  saveTwitchIntegrity?(value: TwitchIntegrity): Promise<void>;
  selectSupplementalWatchTarget?(
    platform: Platform,
    state: SchedulerState,
    settings: S,
    signal?: AbortSignal,
    source?: WatchSourceId,
  ): Promise<SupplementalWatchTarget | undefined>;
  reconcilePageContextRecovery?(
    platform: Platform,
    options: PageContextRecoveryOptions,
    emit: EventEmitter,
  ): Promise<boolean>;
  discardPageContextRecoveryEvidence?(platform: Platform): void;
  lockTracker?: LockTracker;
  // Shared with the tab functions a test drives directly (#598).
  tabRegistry?: TabRegistry;
  wait?(ms: number, signal: AbortSignal): Promise<void>;
  selectWatchTarget?: NonNullable<BackgroundHostPorts["testing"]>["selectWatchTarget"];
  authProbeTimeoutMs?: number;
}

// The capabilities the mocks provide: tabs when the tab mocks are there,
// integrity capture when ensureTwitchIntegrity is, supplemental sources when
// selectSupplementalWatchTarget is. The minute channel-points job runs with tabs
// (the extension set), as the hosts declare it until #590.
export function mockedCapabilities<S extends EngineSettings>(mocks: HostMocks<S>): HostCapabilities {
  const browserTabs = mocks.closeManagedTabs !== undefined;
  return {
    browserTabs,
    twitchIntegrityCapture: mocks.ensureTwitchIntegrity !== undefined,
    supplementalSources: mocks.selectSupplementalWatchTarget !== undefined,
    // Extension-shaped mocks (with tabs) join chat like the extension does.
    chatPresence: browserTabs,
  };
}

export function hostPortsFromMocks<S extends EngineSettings>(
  mocks: HostMocks<S>,
  capabilities: HostCapabilities = mockedCapabilities(mocks),
): BackgroundHostPorts<S> {
  const m = mocks;
  return {
    capabilities,
    storage: {
      loadSettings: () => m.loadSettings(),
      saveSettings: (settings) => m.saveSettings(settings),
      loadState: () => m.loadState(),
      saveState: (state) => m.saveState(state),
      ...(m.applySettingsPatch ? { applySettingsPatch: (current: S, patch: SettingsPatch) => m.applySettingsPatch!(current, patch) } : {}),
    },
    events: {
      report: async (events) => {
        await m.reportEvents?.(events);
      },
      notify: async (notification) => {
        await m.createNotification?.(notification);
      },
      ...(m.translate ? { translate: (key: string, substitutions?: string | string[]) => m.translate!(key, substitutions) } : {}),
    },
    jobs: {
      ensure: (name, schedule) => m.createAlarm(name, schedule),
      cancel: async (name) => (await m.clearAlarm?.(name)) ?? false,
      get: async (name) => m.getAlarm?.(name),
    },
    adapters: {
      createAdapters: (emit, settings) => m.createAdapters(emit, settings),
      createAdapter: (platform, emit, settings) => m.createAdapter(platform, emit, settings),
    },
    ...(m.checkCredentialAvailability
      ? { credentials: { checkAvailability: (platform: Platform) => m.checkCredentialAvailability!(platform) } }
      : {}),
    ...(m.tabRegistry ? { tabRegistry: m.tabRegistry } : {}),
    ...(capabilities.browserTabs
      ? {
        tabs: {
          watch: {
            open: async (channel: ChannelCandidate, session: WatchSession | undefined, options: Partial<WatchTabOptions>, emit: EventEmitter) => {
              if (!m.openWatchTab) throw new Error("No openWatchTab mock");
              return await m.openWatchTab(channel, session, options, emit);
            },
            stop: async (session: WatchSession, options: Partial<WatchTabOptions>, emit: EventEmitter) => {
              await m.stopWatchTab?.(session, options, emit);
            },
            closeManaged: async (tabs: ManagedWatchTab[], origin: Exclude<TabClosureOrigin, "user">) => {
              await m.closeManagedTabs?.(tabs, origin);
            },
            applyAdFocus: async (platform: Platform, tabId: number | undefined, adActive: boolean, emit: EventEmitter) => {
              await m.applyAdFocus?.(platform, tabId, adActive, emit);
            },
            loadPlaybackPolicy: async () => (await m.loadTabPlaybackPolicy?.()) ?? { keepVideosUnmuted: true },
          },
          pageContexts: {
            release: ((contexts, options) => m.stopPageContextTabs!(contexts, options)) as StopPageContextTabs,
            recover: async (platform: Platform, options: PageContextRecoveryOptions, emit: EventEmitter) =>
              (await m.reconcilePageContextRecovery?.(platform, options, emit)) ?? false,
            discardRecoveryEvidence: (platform: Platform) => m.discardPageContextRecoveryEvidence?.(platform),
          },
        },
      }
      : {}),
    twitch: {
      ...(capabilities.twitchIntegrityCapture
        ? {
          integrity: {
            ensure: (emit: EventEmitter, request?: TwitchIntegrityRequest) => m.ensureTwitchIntegrity!(emit, request),
            cancelAcquisition: (reason?: unknown) => m.cancelTwitchIntegrityAcquisition?.(reason),
            load: async () => m.loadTwitchIntegrity?.(),
            save: async (value: TwitchIntegrity) => {
              await m.saveTwitchIntegrity?.(value);
            },
          },
        }
        : {}),
      ...(capabilities.supplementalSources
        ? {
          supplementalSources: {
            select: (state: SchedulerState, settings: S, signal?: AbortSignal, source?: WatchSourceId) =>
              m.selectSupplementalWatchTarget!("twitch", state, settings, signal, source),
          },
        }
        : {}),
    },
    testing: {
      ...(m.lockTracker ? { lockTracker: m.lockTracker } : {}),
      ...(m.wait ? { wait: (ms: number, signal: AbortSignal) => m.wait!(ms, signal) } : {}),
      ...(m.selectWatchTarget ? { selectWatchTarget: m.selectWatchTarget } : {}),
      ...(m.authProbeTimeoutMs === undefined ? {} : { authProbeTimeoutMs: m.authProbeTimeoutMs }),
    },
  };
}
