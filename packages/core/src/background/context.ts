import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import { ObserverSlot } from "./observerSlot";
import type { EngineEvent } from "@lurkloot/shared/events";
import type { TwitchIntegrity } from "../core/twitchIntegrity";
import type { TablessWatchController } from "../core/tablessWatch";
import { createTabRegistry, type TabRegistry } from "../core/tabRegistry";
import type { DiscoverySignalController } from "../core/discoverySignals";
import { DiscoverySnapshotLane } from "../core/discoverySnapshot";
import type {
  CommittedSelection,
  DiscoverySignalRefreshRequest,
  HeartbeatLane,
  PlatformTickResult,
  SelectionInput,
  TickAdapterHandle,
  TickBatch,
  TickRequest,
} from "./types";

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

export interface HeartbeatSlice {
  // Persistent tabless watchers, one per platform, kept alive across discovery
  // ticks (the WebSocket-based Kick watcher in particular must not be recreated
  // each tick). Reconciled against the scheduler's per-platform session state.
  readonly tablessWatchers: Map<Platform, TablessWatchController>;
  readonly heartbeatLanes: Record<Platform, HeartbeatLane>;
}

export function createHeartbeatSlice(): HeartbeatSlice {
  return {
    tablessWatchers: new Map<Platform, TablessWatchController>(),
    heartbeatLanes: {
      twitch: { mutation: Promise.resolve(), revision: 0, coalescedWithoutAttempt: 0 },
      kick: { mutation: Promise.resolve(), revision: 0, coalescedWithoutAttempt: 0 },
    },
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

export interface SettingsSlice {
  twitchSettingsTransitionGeneration: number;
}

export function createSettingsSlice(): SettingsSlice {
  return {
    twitchSettingsTransitionGeneration: 0,
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
  heartbeatSlice: HeartbeatSlice;
  signalSlice: DiscoverySignalSlice;
  discoverySlice: DiscoverySlice<S>;
  tickSlice: TickAdmissionSlice;
  settingsSlice: SettingsSlice;
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
