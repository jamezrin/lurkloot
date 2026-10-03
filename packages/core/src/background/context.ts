import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import { ObserverSlot } from "./observerSlot";
import type { EngineEvent } from "@lurkloot/shared/events";
import type { TwitchIntegrity } from "../core/twitchIntegrity";
import { createTabRegistry, type TabRegistry } from "../core/tabRegistry";
import type { DiscoverySignalController } from "../core/discoverySignals";
import { DiscoverySnapshotLane } from "../core/discoverySnapshot";
import type {
  CommittedSelection,
  DiscoverySignalRefreshRequest,
  PlatformTickResult,
  SelectionInput,
  TickAdapterHandle,
  TickBatch,
  TickDiagnosticContext,
  TickRequest,
} from "./types";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import type { PreparedSettingsCommit } from "./stateTransaction";

// Mutable controller state, one slice per owner (docs/architecture.md,
// "Background controller ownership and concurrency"). createBackgroundController
// creates each slice once and hands every module only the slices it uses.

export interface ReportingSlice {
  readonly controllerRunId: string;
  readonly controllerRunLabel: string;
  // Explicit controller cleanup observes every report, but normal operation
  // completion waits only on its own collector/adapter handle's reports.
  readonly pendingRouteReports: Set<Promise<void>>;
  controllerRunAnnouncement: Promise<void> | undefined;
  readonly reportedCompatibility: Map<Platform, string>;
  readonly reportedCompatibilityWarnings: Set<string>;
}

export function createReportingSlice(): ReportingSlice {
  const controllerRunId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return {
    controllerRunId,
    controllerRunLabel: controllerRunId.slice(0, 8),
    pendingRouteReports: new Set<Promise<void>>(),
    controllerRunAnnouncement: undefined,
    reportedCompatibility: new Map<Platform, string>(),
    reportedCompatibilityWarnings: new Set<string>(),
  };
}

export interface DiscoverySignalSlice {
  readonly discoverySignalSlots: Record<Platform, ObserverSlot<DiscoverySignalController>>;
  readonly discoverySignalPlatformBlocked: Record<Platform, boolean>;
  readonly discoverySignalRefreshRunning: Record<Platform, boolean>;
  readonly discoverySignalRefreshPending: Record<Platform, DiscoverySignalRefreshRequest | undefined>;
  readonly discoverySignalAuthRefreshes: Record<Platform, number>;
  readonly discoverySignalAdmissionGeneration: Record<Platform, number>;
}

export function createDiscoverySignalSlice(): DiscoverySignalSlice {
  return {
    // A failed start stops and clears the observer, and the next reconcile
    // creates a fresh one (#587), as the channel-points push always has.
    discoverySignalSlots: {
      twitch: new ObserverSlot<DiscoverySignalController>("twitch", "discovery signal observer", "discard"),
      kick: new ObserverSlot<DiscoverySignalController>("kick", "discovery signal observer", "discard"),
    },
    discoverySignalPlatformBlocked: {
      twitch: false,
      kick: false,
    },
    discoverySignalRefreshRunning: {
      twitch: false,
      kick: false,
    },
    discoverySignalRefreshPending: {
      twitch: undefined,
      kick: undefined,
    },
    discoverySignalAuthRefreshes: {
      twitch: 0,
      kick: 0,
    },
    discoverySignalAdmissionGeneration: {
      twitch: 0,
      kick: 0,
    },
  };
}

export interface DiscoverySlice<S extends EngineSettings> {
  readonly discoveryEvents: Record<Platform, EngineEvent[]>;
  readonly discoveryLanes: Record<Platform, DiscoverySnapshotLane<TickAdapterHandle<S> | undefined>>;
  readonly discoveryBackoffBypasses: Record<Platform, number>;
  readonly selectionCache: Partial<Record<Platform, CommittedSelection>>;
  readonly selectionRuns: Partial<Record<Platform, Promise<CommittedSelection>>>;
  readonly pendingSelections: Partial<Record<Platform, SelectionInput<S>>>;
  readonly selectionGeneration: Record<Platform, number>;
}

export interface TickAdmissionSlice {
  readonly campaignEvaluationFingerprints: Partial<Record<Platform, string>>;
  // Every tick is bracketed by a start/finish diagnostic carrying its trigger and
  // elapsed time. A tick that succeeds otherwise emits nothing about itself, which
  // makes a slow one indistinguishable from an idle gap in an exported log.
  globalTickSequence: number;
  readonly platformTickSequence: Record<Platform, number>;
  // Chain of detached ticks, drained by settleBackgroundWork().
  backgroundWork: Promise<unknown>;
  readonly activeTicks: Set<AbortController>;
  readonly activePlatformTicks: Record<Platform, number>;
  tickCommitSequence: number;
  readonly tickAdmission: Record<Platform, { active?: TickRequest; pending?: TickRequest }>;
  readonly tickRequestHandoffs: WeakMap<Promise<PlatformTickResult>, Promise<SchedulerState | undefined>>;
  tickAdmissionSuspended: boolean;
  readonly tickBatches: Set<TickBatch>;
}

export function createTickAdmissionSlice(): TickAdmissionSlice {
  return {
    campaignEvaluationFingerprints: {},
    globalTickSequence: 0,
    platformTickSequence: {
      twitch: 0,
      kick: 0,
    },
    backgroundWork: Promise.resolve(),
    activeTicks: new Set<AbortController>(),
    activePlatformTicks: {
      twitch: 0,
      kick: 0,
    },
    tickCommitSequence: 0,
    tickAdmission: {
      twitch: {},
      kick: {},
    },
    tickRequestHandoffs: new WeakMap<Promise<PlatformTickResult>, Promise<SchedulerState | undefined>>(),
    tickAdmissionSuspended: false,
    tickBatches: new Set<TickBatch>(),
  };
}

// One turn of a settings commit, for a service that has to take part in it
// rather than only react afterwards (#696): Twitch integrity holds off its
// work from the moment a save may disable Twitch until it has reconciled.
export interface SettingsCommitTurn<S> {
  // In the settings lock, once the commit is worked out and before it is saved.
  prepared(commit: PreparedSettingsCommit<S>): void;
  // After the save and the settings jobs' reschedule, or after the save failed
  // (`saved` false). `proceed` is false when the jobs' reschedule failed.
  end(saved: boolean, proceed: boolean): Promise<void>;
}

// Per-platform policy that platform-neutral modules (settings transitions,
// tick coordination) apply without naming a platform (#696). Each platform's
// own service registers its part at construction; a platform that registered
// nothing needs nothing.
export interface PlatformPolicySlice<S extends EngineSettings> {
  // Asked before a tick farms the platform; false keeps it out of the tick.
  tickReadiness: Partial<Record<Platform, (settings: S, signal: AbortSignal, tickContext: TickDiagnosticContext) => Promise<boolean>>>;
  // Starts the platform switch's transition, superseding earlier ones, and
  // returns whether this one is still the latest.
  switchTransitions: Partial<Record<Platform, () => () => boolean>>;
  // Joins every settings commit, from before its lock is taken. `intent` is
  // what the caller means to save, when it is known up front.
  settingsCommitParticipants: Array<(intent: SettingsPatch | undefined) => SettingsCommitTurn<S>>;
}

export function createPlatformPolicySlice<S extends EngineSettings>(): PlatformPolicySlice<S> {
  return {
    tickReadiness: {},
    switchTransitions: {},
    settingsCommitParticipants: [],
  };
}

export interface LifecycleSlice {
  controllerShutdown: boolean;
  // One gate for every long-lived observer kind (#587): the discovery-signal
  // observers and the Twitch channel-points push. Closed by shutdown and for
  // the length of a host reset; while closed, no observer is created, and one
  // that finishes starting is stopped again.
  observersOpen: boolean;
}

export function createLifecycleSlice(): LifecycleSlice {
  return {
    controllerShutdown: false,
    observersOpen: true,
  };
}

// One tab registry per controller (#598). A host with tabs passes the one its
// tab mechanics use; a host without them gets an empty one of its own.
export function createTabRegistrySlice(hostRegistry: TabRegistry | undefined): TabRegistry {
  return hostRegistry ?? createTabRegistry();
}

export interface ControllerSlices<S extends EngineSettings> {
  reportingSlice: ReportingSlice;
  signalSlice: DiscoverySignalSlice;
  tickSlice: TickAdmissionSlice;
  policySlice: PlatformPolicySlice<S>;
  lifecycleSlice: LifecycleSlice;
  // Shared with the host that runs the tab mechanics (#598).
  tabRegistry: TabRegistry;
}

// Calls into sibling modules. Modules call each other in both directions, so
// createBackgroundController creates them all before any of them runs: each
// module takes the functions it calls from here, and they resolve on first use.
export function lateBound<T extends object>(calls: T): T {
  return new Proxy(calls, {
    get: (target, name) => (...args: unknown[]) =>
      (Reflect.get(target, name) as (...args: unknown[]) => unknown)(...args),
  });
}
