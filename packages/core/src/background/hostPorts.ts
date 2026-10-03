import type { CompatibilityResolution, ResolvedCompatibility } from "@lurkloot/shared/compatibility";
import type { EventEmitter, EventReporter } from "@lurkloot/shared/events";
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
import type { selectWatchTargetFromSnapshot, StopPageContextTabs } from "../core/scheduler";
import type { TabRegistry, TwitchIntegrityRequest } from "../core/tabRegistry";
import type { TwitchIntegrity } from "../core/twitchIntegrity";
import type { PlatformAdapter } from "../platforms/adapter";
import type { JobSchedulerPort } from "./jobs";
import type { LockTracker } from "./stateTransaction";

// The host contract (#593). The extension and the CLI both build the controller
// from these ports. What a host cannot do is declared in `capabilities`, and the
// port for it is left out; createBackgroundController checks the two agree, so
// a missing port never silently switches a feature off.

// Declared by hand by each host. Two hosts and a handful of capabilities need
// no dependency resolution.
export interface HostCapabilities {
  // Watch tabs and ad focus (`tabs.watch`), page-context tabs and their recovery
  // (`tabs.pageContexts`), and the tab registry they share (`tabRegistry`).
  // Without it every watch is tabless.
  readonly browserTabs: boolean;
  // Capturing a Twitch integrity token through a browser page (`twitch.integrity`).
  readonly twitchIntegrityCapture: boolean;
  // Supplemental watch sources such as Twitch Extensions (`twitch.supplementalSources`).
  readonly supplementalSources: boolean;
}

export const EXTENSION_CAPABILITIES: HostCapabilities = {
  browserTabs: true,
  twitchIntegrityCapture: true,
  supplementalSources: true,
};

export const CLI_CAPABILITIES: HostCapabilities = {
  browserTabs: false,
  twitchIntegrityCapture: false,
  supplementalSources: false,
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
//
// Whenever `stop` or `closeManaged` closes a tab, the host records why with
// noteTabClosure (tabRegistry.ts) before it asks the browser to, and drops the
// record if the close fails. The controller reads it when the removal event
// arrives, so only a close the user made pauses farming (#598).
export interface WatchTabPort {
  open(
    channel: ChannelCandidate,
    session: WatchSession | undefined,
    options: Partial<WatchTabOptions>,
    emit: EventEmitter,
  ): Promise<PreparedWatchTab>;
  stop(session: WatchSession, options: Partial<WatchTabOptions>, emit: EventEmitter): Promise<void>;
  // Closes the managed watch tabs a state held; `origin` is recorded against
  // each tab it closes, so its removal event is not read as the user's.
  closeManaged(tabs: ManagedWatchTab[], origin: Exclude<TabClosureOrigin, "user">): Promise<void>;
  // Tab-mode ad focus. The host owns the focus policy (adFocusMode), so the
  // engine only reports whether an ad is active for a given watch tab.
  applyAdFocus(platform: Platform, tabId: number | undefined, adActive: boolean, emit: EventEmitter): Promise<void>;
  // The playback policy the host applies to managed watch tabs.
  loadPlaybackPolicy(): Promise<{ keepVideosUnmuted: boolean }>;
}

// The other direction (#598): the tab events a host with browser tabs forwards
// to the controller, which implements this. Playback telemetry arrives as the
// `playbackTelemetry` runtime message. Each is judged against the tab registry:
// a removal carries the closure origin the engine recorded (only a `user` close
// pauses farming), and a report from a tab the engine released is ignored.
export interface TabEventsPort {
  handleTabRemoved(tabId: number): Promise<void>;
  handleTabUpdated(tabId: number, url: string): Promise<void>;
}

// The tabs the engine borrows to run requests in a platform page.
export interface PageContextPort {
  // Page-context tab teardown, also the Kick runtime's handler for the
  // scheduler tick's releasePageContexts effect (#588).
  release: StopPageContextTabs;
  // Recovery from a page context opened when a background request was rejected
  // (only Kick opens one). The host gathers route evidence as requests run; this
  // takes what one committed cycle gathered and applies the registry's recovery
  // rule (observePageContextRecovery), closing the platform's retained page
  // context once direct requests have worked for the host's configured number
  // of cycles in a row. Resolves true when the page contexts changed. The engine
  // decides when a cycle counts; the host keeps the evidence and the tab.
  recover(platform: Platform, options: PageContextRecoveryOptions, emit: EventEmitter): Promise<boolean>;
  // Drops the evidence a cycle gathered when that cycle did not commit.
  discardRecoveryEvidence(platform: Platform): void;
}

export interface PageContextRecoveryOptions {
  // False when the cycle's discovery did not complete, so its direct successes
  // must not count towards recovery; a fallback still resets it.
  countBackgroundSuccess: boolean;
}

// Twitch integrity capture through a browser page (capability
// `twitchIntegrityCapture`).
export interface TwitchIntegrityPort {
  ensure(emit: EventEmitter, request?: TwitchIntegrityRequest): Promise<boolean>;
  // Aborts an acquisition in flight. Synchronous: it waits on nothing. It is
  // the only way to stop one: a request's signal only stops that caller waiting.
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
