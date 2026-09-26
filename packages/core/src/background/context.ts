import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import type { EngineEvent } from "@lurkloot/shared/events";
import type { TwitchIntegrity } from "../core/twitchIntegrity";
import type { TablessWatchController } from "../core/tablessWatch";
import type { DiscoverySignalController } from "../core/discoverySignals";
import type { TwitchChannelPointsPushController } from "../platforms/twitch/channelPointsPush";
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

export interface StateCommitSlice {
  readonly platformMutations: Record<Platform, Promise<unknown>>;
  stateCommit: Promise<unknown>;
}

export function createStateCommitSlice(): StateCommitSlice {
  return {
    platformMutations: {
      twitch: Promise.resolve(),
      kick: Promise.resolve(),
    },
    stateCommit: Promise.resolve(),
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

export interface TwitchIntegritySlice {
  twitchIntegrityAlarmMutation: Promise<unknown>;
  integrityRefreshAbort: AbortController | undefined;
  integrityLifecycleGeneration: number;
  integrityLifecycleOpen: boolean;
  installedTwitchIntegrity: TwitchIntegrity | undefined;
  persistedIntegrityToken: string | undefined;
  // A missing rejectedToken means there was no usable bundle when the refresh
  // became due. Keeping the wrapper object distinguishes that from "not due."
  twitchIntegrityRefreshDue: { rejectedToken?: string } | undefined;
  // The startup load of the stored integrity token. createBackgroundController
  // starts it once every module exists.
  initialTwitchIntegrityLoad: Promise<void>;
}

export function createTwitchIntegritySlice(): TwitchIntegritySlice {
  return {
    twitchIntegrityAlarmMutation: Promise.resolve(),
    integrityRefreshAbort: undefined,
    integrityLifecycleGeneration: 0,
    integrityLifecycleOpen: true,
    installedTwitchIntegrity: undefined,
    persistedIntegrityToken: undefined,
    twitchIntegrityRefreshDue: undefined,
    // Replaced by createBackgroundController once every module exists.
    initialTwitchIntegrityLoad: Promise.resolve(),
  };
}

export interface ChannelPointsSlice {
  twitchChannelPointsPush: TwitchChannelPointsPushController | undefined;
  readonly twitchChannelPointsClaimInFlight: Set<string>;
}

export function createChannelPointsSlice(): ChannelPointsSlice {
  return {
    twitchChannelPointsPush: undefined,
    twitchChannelPointsClaimInFlight: new Set<string>(),
  };
}

export interface KickChallengeSlice {
  readonly kickChallengeClaimOperations: Set<AbortController>;
}

export function createKickChallengeSlice(): KickChallengeSlice {
  return {
    kickChallengeClaimOperations: new Set<AbortController>(),
  };
}

export interface AuthHealthSlice {
  readonly authRefreshGeneration: Record<Platform, number>;
}

export function createAuthHealthSlice(): AuthHealthSlice {
  return {
    authRefreshGeneration: {
      twitch: 0,
      kick: 0,
    },
  };
}

export interface ClaimSlice {
  // In-flight post-claim handoffs, one per platform. A claim arriving while a
  // handoff is already running for that platform is absorbed by the running
  // loop rather than starting a second one, which is what keeps the work
  // bounded. Per-controller, unlike the storage lock: these loops coordinate
  // only with each other.
  readonly claimHandoffs: Map<Platform, AbortController>;
  readonly waitingClaimRewardIds: Record<Platform, Set<string>>;
  readonly dropClaimOperations: Record<Platform, Set<AbortController>>;
}

export function createClaimSlice(): ClaimSlice {
  return {
    claimHandoffs: new Map<Platform, AbortController>(),
    waitingClaimRewardIds: {
      twitch: new Set<string>(),
      kick: new Set<string>(),
    },
    dropClaimOperations: {
      twitch: new Set<AbortController>(),
      kick: new Set<AbortController>(),
    },
  };
}

export interface DiscoverySignalSlice {
  readonly discoverySignalControllers: Map<Platform, DiscoverySignalController>;
  readonly discoverySignalPlatformBlocked: Record<Platform, boolean>;
  discoverySignalLifecycleOpen: boolean;
  readonly discoverySignalRefreshRunning: Record<Platform, boolean>;
  readonly discoverySignalRefreshPending: Record<Platform, DiscoverySignalRefreshRequest | undefined>;
  readonly discoverySignalAuthRefreshes: Record<Platform, number>;
  readonly discoverySignalAdmissionGeneration: Record<Platform, number>;
}

export function createDiscoverySignalSlice(): DiscoverySignalSlice {
  return {
    discoverySignalControllers: new Map<Platform, DiscoverySignalController>(),
    discoverySignalPlatformBlocked: {
      twitch: false,
      kick: false,
    },
    discoverySignalLifecycleOpen: true,
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
  settingsMutation: Promise<unknown>;
  twitchSettingsTransitionGeneration: number;
  lastPersistedTwitchEnabled: boolean | undefined;
}

export function createSettingsSlice(): SettingsSlice {
  return {
    settingsMutation: Promise.resolve(),
    twitchSettingsTransitionGeneration: 0,
    lastPersistedTwitchEnabled: undefined,
  };
}

export interface LifecycleSlice {
  controllerShutdown: boolean;
}

export function createLifecycleSlice(): LifecycleSlice {
  return {
    controllerShutdown: false,
  };
}

export interface ControllerSlices<S extends EngineSettings> {
  reportingSlice: ReportingSlice;
  commitSlice: StateCommitSlice;
  heartbeatSlice: HeartbeatSlice;
  integritySlice: TwitchIntegritySlice;
  channelPointsSlice: ChannelPointsSlice;
  kickChallengeSlice: KickChallengeSlice;
  authSlice: AuthHealthSlice;
  claimSlice: ClaimSlice;
  signalSlice: DiscoverySignalSlice;
  discoverySlice: DiscoverySlice<S>;
  tickSlice: TickAdmissionSlice;
  settingsSlice: SettingsSlice;
  lifecycleSlice: LifecycleSlice;
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
