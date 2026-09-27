import type { CompatibilityResolution, ResolvedCompatibility } from "@lurkloot/shared/compatibility";
import type { EventEmitter, EventReporter } from "@lurkloot/shared/events";
import type {
  ChannelCandidate,
  EngineSettings,
  ManagedWatchTab,
  Platform,
  SchedulerState,
  SupplementalWatchTarget,
  WatchSession,
  WatchSourceId,
} from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import type { selectWatchTargetFromSnapshot, StopPageContextTabs } from "../core/scheduler";
import type { TabRegistry, TwitchIntegrityRequest } from "../core/tabs";
import type { TwitchIntegrity } from "../core/twitchIntegrity";
import type { PlatformAdapter, PreparedWatchTab, WatchTabOptions } from "../platforms/adapter";
import type { JobSchedulerPort } from "./jobs";
import type { LockTracker } from "./stateTransaction";

// The host contract (#593). The extension and the CLI both build the controller
// from these ports. What a host cannot do is declared in `capabilities`, and the
// port for it is left out; createBackgroundController checks the two agree, so
// a missing port never silently switches a feature off.

// Declared by hand by each host. Two hosts and a handful of capabilities need
// no dependency resolution.
export interface HostCapabilities {
  // Watch tabs and ad focus (`tabs.watch`), page-context tabs (`tabs.pageContexts`,
  // and the Kick page-context recovery in `kick.pageContextRecovery`), and the
  // tab registry they share (`tabRegistry`). Without it every watch is tabless.
  readonly browserTabs: boolean;
  // Capturing a Twitch integrity token through a browser page (`twitch.integrity`).
  readonly twitchIntegrityCapture: boolean;
  // Supplemental watch sources such as Twitch Extensions (`twitch.supplementalSources`).
  readonly supplementalSources: boolean;
  // Runs the 1-minute Twitch channel-points job. Without it, channel points are
  // claimed as a tick side effect at poll cadence. #590 enables it on the CLI.
  readonly twitchChannelPointsJob: boolean;
}

export const EXTENSION_CAPABILITIES: HostCapabilities = {
  browserTabs: true,
  twitchIntegrityCapture: true,
  supplementalSources: true,
  twitchChannelPointsJob: true,
};

export const CLI_CAPABILITIES: HostCapabilities = {
  browserTabs: false,
  twitchIntegrityCapture: false,
  supplementalSources: false,
  twitchChannelPointsJob: false,
};

// Generic over the host's settings type `S`, which must satisfy the engine
// contract (EngineSettings). The extension parametrizes it with its fuller
// ExtensionSettings (load/save round-trip the host-only fields); the CLI uses the
// bare EngineSettings. The engine itself only ever reads EngineSettings fields.
export interface StoragePort<S extends EngineSettings> {
  loadSettings(): Promise<S>;
  // The CLI's settings come from its config file, so its save does nothing.
  saveSettings(settings: S): Promise<void>;
  loadState(): Promise<SchedulerState>;
  saveState(state: SchedulerState): Promise<void>;
  // Applies a popup settings patch to the host's full settings. Only popup
  // messages patch settings, and the CLI sends none, so it can leave this out.
  applySettingsPatch?(current: S, patch: SettingsPatch): S;
}

export interface EventsPort {
  report: EventReporter;
  notify(notification: { title: string; message: string }): Promise<void>;
  // Localizes notification copy. Without it the engine uses the message key.
  translate?(key: string, substitutions?: string | string[]): string | Promise<string>;
}

export type CredentialAvailability =
  | { status: "available" }
  | { status: "missing" }
  | { status: "unavailable" };

export interface CredentialsPort {
  // Whether a platform has a credential before a live probe, so the engine can
  // tell missing_credentials from a rejected or unavailable one.
  checkAvailability(platform: Platform): Promise<CredentialAvailability>;
}

// Adapter construction, compatibility resolution and route diagnostics.
export interface AdaptersPort<S extends EngineSettings> {
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
}

// Browser tabs (capability `browserTabs`), one port per role (#598). Only the
// extension implements them; the engine decides when a tab is opened or closed.
export interface BrowserTabsPort {
  watch: WatchTabPort;
  pageContexts: PageContextPort;
}

// The pinned, muted tab a platform is watched in. The host applies its own tab
// settings (muting, keeping videos unmuted, closing managed tabs) on top of the
// options the engine passes, and reports its diagnostics through `emit`.
export interface WatchTabPort {
  open(
    channel: ChannelCandidate,
    session: WatchSession | undefined,
    options: Partial<WatchTabOptions>,
    emit: EventEmitter,
  ): Promise<PreparedWatchTab>;
  stop(session: WatchSession, options: Partial<WatchTabOptions>, emit: EventEmitter): Promise<void>;
  closeManaged(tabs: ManagedWatchTab[]): Promise<void>;
  // Tab-mode ad focus. The host owns the focus policy (adFocusMode), so the
  // engine only reports whether an ad is active for a given watch tab.
  applyAdFocus(platform: Platform, tabId: number | undefined, adActive: boolean, emit: EventEmitter): Promise<void>;
  // The playback policy the host applies to managed watch tabs.
  loadPlaybackPolicy(): Promise<{ keepVideosUnmuted: boolean }>;
}

// The tabs the engine borrows to run requests in a platform page.
export interface PageContextPort {
  // Page-context tab teardown, also injected into the scheduler tick.
  release: StopPageContextTabs;
}

// Twitch integrity capture through a browser page (capability
// `twitchIntegrityCapture`).
export interface TwitchIntegrityPort {
  ensure(emit: EventEmitter, request?: TwitchIntegrityRequest): Promise<boolean>;
  // Aborts an acquisition in flight. Synchronous: it waits on nothing.
  cancelAcquisition(reason?: unknown): void;
  load(): Promise<TwitchIntegrity | undefined>;
  save(value: TwitchIntegrity): Promise<void>;
}

// Supplemental watch sources such as Twitch Extensions (capability
// `supplementalSources`). #587 adds the `prepare` half, run with no lock held.
export interface SupplementalSourcesPort<S extends EngineSettings> {
  select(
    state: SchedulerState,
    settings: S,
    signal?: AbortSignal,
    source?: WatchSourceId,
  ): Promise<SupplementalWatchTarget | undefined>;
}

export interface TwitchHostPorts<S extends EngineSettings> {
  integrity?: TwitchIntegrityPort;
  supplementalSources?: SupplementalSourcesPort<S>;
}

// Kick page contexts opened when a background request was rejected, closed
// again once direct requests work (part of capability `browserTabs`).
export interface KickPageContextRecoveryPort<S extends EngineSettings> {
  reconcile(settings: S, options: { countBackgroundSuccess: boolean }, emit: EventEmitter): Promise<boolean>;
  discardEvidence(): void;
}

export interface KickHostPorts<S extends EngineSettings> {
  pageContextRecovery?: KickPageContextRecoveryPort<S>;
}

// Seams for tests. Hosts leave them out.
export interface TestingPorts {
  // The state transaction's lock-order and locked-I/O checks (stateTransaction.ts).
  lockTracker?: LockTracker;
  // Delay used by the bounded post-claim handoff, so tests drive the loop by
  // hand. Resolves early (without throwing) when the signal aborts.
  wait?(ms: number, signal: AbortSignal): Promise<void>;
  selectWatchTarget?: typeof selectWatchTargetFromSnapshot;
  authProbeTimeoutMs?: number;
}

export interface BackgroundHostPorts<S extends EngineSettings = EngineSettings> {
  capabilities: HostCapabilities;
  storage: StoragePort<S>;
  events: EventsPort;
  jobs: JobSchedulerPort;
  adapters: AdaptersPort<S>;
  credentials?: CredentialsPort;
  tabs?: BrowserTabsPort;
  // The registry the host's tab mechanics write to, shared with the controller
  // (#598). Left out by a host without tabs; the controller then makes its own.
  tabRegistry?: TabRegistry;
  twitch: TwitchHostPorts<S>;
  kick: KickHostPorts<S>;
  testing?: TestingPorts;
}

export class HostCapabilityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostCapabilityMismatchError";
  }
}

// Each capability's ports are present exactly when the host declares it.
export function assertHostCapabilities<S extends EngineSettings>(ports: BackgroundHostPorts<S>): void {
  const checks: Array<readonly [keyof HostCapabilities, string, boolean]> = [
    ["browserTabs", "tabs", ports.tabs !== undefined],
    ["browserTabs", "kick.pageContextRecovery", ports.kick.pageContextRecovery !== undefined],
    ["twitchIntegrityCapture", "twitch.integrity", ports.twitch.integrity !== undefined],
    ["supplementalSources", "twitch.supplementalSources", ports.twitch.supplementalSources !== undefined],
  ];
  for (const [capability, port, present] of checks) {
    if (ports.capabilities[capability] === present) continue;
    throw new HostCapabilityMismatchError(present
      ? `The host passes ${port} but does not declare the ${capability} capability`
      : `The host declares the ${capability} capability but does not pass ${port}`);
  }  // Not the other way round: a registry without tabs is harmless. But a tab host
  // that forgets it would read integrity and page contexts from a registry the
  // controller never writes to.
  if (ports.capabilities.browserTabs && ports.tabRegistry === undefined) {
    throw new HostCapabilityMismatchError("The host declares the browserTabs capability but does not pass tabRegistry");
  }
}
