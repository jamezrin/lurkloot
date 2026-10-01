import type { CategorySearchResult, CoreRuntimeMessage, PlaybackControl, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { EngineSettings, Platform, PlaybackTelemetry, SchedulerState, TablessHeartbeatCadence, WatchSession } from "@lurkloot/shared/models";
import type { DiagnosticEvent, EngineEvent, EventEmitter } from "@lurkloot/shared/events";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import type { SnapshotSelectionResult } from "../core/scheduler";
import type { IntegrityHeader } from "../core/twitchIntegrity";
import type { PlatformAdapter } from "../platforms/adapter";
import type { TablessWatchController } from "../core/tablessWatch";
import type { DiscoverySignalController } from "../core/discoverySignals";
import type { DiscoverySnapshot, DiscoverySnapshotState } from "../core/discoverySnapshot";
import { AuthProbeSetupError } from "./errors";
import type { CommitGuard, CommitOptions, CommitResult, PreparedSettingsCommit } from "./stateTransaction";
import type { TickEffectExecutor } from "./tickEffects";

// Reward ids claimed during one tick, per platform. The post-claim handoff needs
// the ids (not just the platforms) so it can tell a genuine successor from the
// reward that was just claimed.
export type ClaimedRewards = Partial<Record<Platform, string[]>>;
// What caused a tick to run. Recorded in the tick's lifecycle diagnostics so an
// exported log distinguishes a user action from a timer or a post-claim handoff.
export type TickTrigger =
  | "alarm"
  | "watch_alarm"
  | "startup"
  | "install"
  | "automation_toggle"
  | "platform_toggle"
  | "settings_saved"
  // A save that only reordered what is farmed (pins, strategy, favourite
  // games): the current discovery still holds, so the tick re-selects from it.
  | "ranking_changed"
  | "manual_watch"
  | "manual_resume"
  | "manual_tick"
  | "critical_failure_dismissed"
  | "tabless_fallback"
  | "claim_handoff"
  | "discovery_signal"
  // Another writer committed while the tick ran its effects, so the tick's
  // decision was dropped (#599): decide again from the discovery already held.
  | "tick_superseded"
  | "unknown";

export type TickDiagnosticContext = Required<Pick<
  DiagnosticEvent,
  "globalTickId" | "platformTickId"
>>;
export type { CredentialAvailability } from "./hostPorts";

// What a tick cycle's commit left, for the services that follow tick cycles
// (Kick page-context recovery, #588): the committed state and the platforms
// whose discovery completed, or a failure the tick persisted instead.
export type TickCycleOutcome =
  | { status: "committed"; state: SchedulerState; discoveryComplete: ReadonlySet<Platform> }
  | { status: "failed" };

export interface CommittedHeartbeatContext {
  readonly generation: number;
  readonly contextKey: string;
  readonly session: Readonly<WatchSession>;
  readonly watcher: TablessWatchController;
}

export type HeartbeatAttemptKind = "scheduled" | "immediate";

export interface HeartbeatAttempt {
  readonly generation: number;
  readonly contextKey: string;
  readonly dueAt: number;
  readonly attemptAt: number;
  readonly synchronizationDelayMs: number;
  coalescedCalls: number;
  // Whether the watch job's heartbeat ran or joined it. Only those ask for a
  // tab fallback.
  scheduled: boolean;
  readonly promise: Promise<void>;
}

export interface HeartbeatFallback {
  readonly platform: Platform;
  readonly generation: number;
  readonly contextKey: string;
}

export interface HeartbeatResultCommit {
  readonly attempt: HeartbeatAttempt;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

export interface HeartbeatRecoveryCommit {
  readonly generation: number;
  readonly contextKey: string;
  readonly expectedPersistedCadence?: Readonly<TablessHeartbeatCadence>;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

// A tick's claim on a lane, from its reservation inside the platform lock until
// it publishes or releases after the commit. Heartbeats and recovery wait for
// it to settle; a result for the context it replaces is stale.
export interface HeartbeatPublicationLease {
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

// What a tick's reservation does to one platform's watcher once it commits.
export type WatcherPlan =
  | { readonly kind: "none"; readonly platform: Platform }
  | {
      readonly kind: "keep";
      readonly platform: Platform;
      readonly watcher: TablessWatchController;
      readonly cadence: TablessHeartbeatCadence | undefined;
    }
  | { readonly kind: "stop"; readonly platform: Platform; readonly lease: HeartbeatPublicationLease }
  | {
      readonly kind: "start";
      readonly platform: Platform;
      readonly lease: HeartbeatPublicationLease;
      readonly session: WatchSession;
      readonly watcher: TablessWatchController;
      // False for a watcher published without a context, started again
      // instead of replaced.
      readonly created: boolean;
      // Absent when the session has no heartbeat context.
      readonly context?: {
        readonly generation: number;
        readonly contextKey: string;
        readonly cadence: TablessHeartbeatCadence;
      };
    };

// The tabless watchers a tick reserved inside its lock (#586).
export interface HeartbeatReservation {
  // After the tick's commit, with no lock held: starts, switches or stops the
  // watchers and publishes them. Nothing is published once a newer
  // reservation or ownership cleanup replaced this one.
  publish(emit: EventEmitter): Promise<void>;
  // When the tick does not commit: gives the reservations up unpublished.
  release(): Promise<void>;
}

export interface HeartbeatWatcherRemoval {
  accepted: boolean;
  watcher?: TablessWatchController;
}

export type HeartbeatWatcherRemovalDecision = HeartbeatWatcherRemoval | {
  waitFor: Promise<void>;
};

export interface HeartbeatLane {
  mutation: Promise<unknown>;
  revision: number;
  committed?: CommittedHeartbeatContext;
  // A tick reserves this inside its platform lock before starting, switching or
  // stopping a watcher, and ends it when it publishes after its commit or gives
  // the reservation up (#586). Heartbeats and recovery wait for it; a result
  // for the context it replaces is rejected at once.
  publicationLease?: HeartbeatPublicationLease;
  inFlight?: HeartbeatAttempt;
  // Reserved only after transport completes, while the result commits. A
  // publication does not wait for it: the result's commit only lands while the
  // stored session still carries its generation.
  resultCommit?: HeartbeatResultCommit;
  // Set from a restart recovery's reservation until its watcher is published
  // and its cadence persisted. The watcher starts with no lane held.
  recoveryCommit?: HeartbeatRecoveryCommit;
  generationHighWater?: number;
  lastCompletedGeneration?: number;
  lastCompletedContextKey?: string;
  coalescedWithoutAttempt: number;
}

export interface SettingsCommitOptions {
  // The patch the caller is about to commit, when it knows it before the
  // settings lock: services that must react at once (a Twitch disable cancels
  // an integrity mint in flight, #589) act on it while the commit waits.
  intent?: SettingsPatch;
}

export interface TickAdapterHandle<S extends EngineSettings> {
  readonly platform: Platform;
  adapter(settings: S, emit: EventEmitter, reportCompatibility?: boolean): PlatformAdapter;
  drain(emit: EventEmitter): void;
  close(): void;
  settleRouteReports(): Promise<void>;
}

export interface SelectionInput<S extends EngineSettings> {
  platform: Platform;
  trigger: TickTrigger;
  snapshot: DiscoverySnapshot;
  settings: S;
  state: SchedulerState;
  key: string;
  force: boolean;
  signal: AbortSignal;
  generation: number;
}

export interface CommittedSelection {
  key: string;
  snapshotRevision: number;
  generation: number;
  result: SnapshotSelectionResult;
}

export type DiscoverySignalRefreshRequest = {
  controller: DiscoverySignalController;
  generation: number;
  count: number;
};

export type PlatformTickResult = readonly [Platform, string[], { state: SchedulerState; sequence: number }?];

export interface TickRequest {
  trigger: TickTrigger;
  reasons: Partial<Record<TickTrigger, number>>;
  discoverySignal?: DiscoverySignalRefreshRequest;
  promise: Promise<PlatformTickResult>;
  resolve: (result: PlatformTickResult) => void;
  reject: (error: unknown) => void;
}

export interface TickBatch {
  requests: Promise<PlatformTickResult>[];
  settled: Promise<PromiseSettledResult<PlatformTickResult>[]>;
  claimed?: Promise<ClaimedRewards>;
  handoff?: Promise<SchedulerState | undefined>;
}

// Every function a module calls in another module, or that the controller
// returns, by owner. A module's parameters pick the entries it calls, and its
// return type picks the entries it provides.
export interface ControllerCalls<S extends EngineSettings> {
  // reporting.ts
  createAdapters(settings: S, emit: EventEmitter): Record<Platform, PlatformAdapter>;
  createAdapter(platform: Platform, settings: S, emit: EventEmitter, reportCompatibility?: boolean): PlatformAdapter;
  createSelectedAdapters(
    settings: S,
    emit: EventEmitter,
    platforms: readonly Platform[],
  ): Record<Platform, PlatformAdapter>;
  createTickAdapterHandle(platform: Platform, tickContext: TickDiagnosticContext): TickAdapterHandle<S>;
  withEventCollector<T>(
    operation: (emit: EventEmitter, events: EngineEvent[]) => Promise<T>,
    tickContext?: TickDiagnosticContext,
  ): Promise<T>;
  clearOperationalEvents(events: EngineEvent[]): void;
  diagnosticEvent(
    level: "debug" | "info" | "warn",
    message: string,
    platform?: Platform,
    tickContext?: TickDiagnosticContext,
    data?: DiagnosticEvent["data"],
  ): void;
  reportBestEffort(events: readonly EngineEvent[]): Promise<void>;
  playbackEvents(
    platform: Platform,
    previous: PlaybackTelemetry | undefined,
    telemetry: Omit<PlaybackTelemetry, "platform" | "checkedAt">,
  ): DiagnosticEvent[];
  safeNotify(title: string, message: string): Promise<void>;
  tr(key: string, substitutions?: string | string[]): Promise<string>;
  reportUnsupportedSettings(settings: EngineSettings, tickContext?: TickDiagnosticContext): Promise<void>;
  emitNotifications(
    settings: EngineSettings,
    previous: SchedulerState,
    next: SchedulerState,
    tickEvents?: readonly EngineEvent[],
  ): Promise<void>;

  // stateCommit.ts
  withSettingsLock<T>(operation: () => Promise<T>): Promise<T>;
  withPlatformLock<T>(platform: Platform, operation: () => Promise<T>): Promise<T>;
  withStateLock<T>(operation: () => Promise<T>, platforms?: readonly Platform[]): Promise<T>;
  trackHeartbeatLane<T>(operation: () => Promise<T>): Promise<T>;
  readState(): Promise<SchedulerState>;
  // Bumped by every scheduler-state save.
  stateRevision(): number;
  readSettingsAndState(): Promise<[S, SchedulerState]>;
  commitState(
    platforms: readonly Platform[],
    guard: CommitGuard | undefined,
    mutate: (latest: SchedulerState) => SchedulerState | undefined,
    options?: CommitOptions,
  ): Promise<CommitResult>;
  persistAndReport(state: SchedulerState, events?: readonly EngineEvent[]): Promise<void>;
  persistPlatformAndReport(
    platform: Platform,
    state: SchedulerState,
    events?: readonly EngineEvent[],
    isCurrent?: () => boolean,
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<boolean>;
  persistPlatformState(
    platform: Platform,
    state: SchedulerState,
    isCurrent?: () => boolean,
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<boolean>;
  saveOperationalState(state: SchedulerState): Promise<void>;
  // Resolves once every after-commit hook for the commits made so far to
  // `platforms` (by default, every platform) has run.
  settleCommitHooks(platforms?: readonly Platform[]): Promise<void>;

  // Owner methods for state other modules used to write directly (#591).
  // discovery.ts
  invalidateDiscoveryLane(platform: Platform): void;
  stopDiscoveryLane(platform: Platform): void;
  recordDiscoveryEvent(platform: Platform, event: EngineEvent): void;
  drainDiscoveryEvents(platform: Platform): EngineEvent[];
  selectionGeneration(platform: Platform): number;
  // tickAdmission.ts
  trackBackgroundWork(run: Promise<unknown>): void;
  suspendTickAdmission(): void;
  resumeTickAdmission(): void;
  discardStalePendingTick(platform: Platform): void;
  platformTickRunning(platform: Platform): boolean;
  platformTickAdmitted(platform: Platform): boolean;
  // reporting.ts
  settleRouteReports(): Promise<boolean>;
  // discoverySignals.ts
  setDiscoverySignalPlatformBlocked(platform: Platform, blocked: boolean): void;
  takeAllowedDiscoverySignalRefresh(platform: Platform): DiscoverySignalRefreshRequest | undefined;
  // settingsTransitions.ts
  beginTwitchSettingsTransition(): () => boolean;
  invalidateTwitchSettingsTransitions(): void;
  currentTwitchSettingsTransition(): number;

  // heartbeat.ts
  ensureHeartbeatJob(): Promise<void>;
  cancelHeartbeatPublicationLeases(platforms: readonly Platform[]): Promise<void>;
  reserveTablessWatchers(
    state: SchedulerState,
    settings: EngineSettings,
    adapters: Record<Platform, PlatformAdapter>,
    platforms?: readonly Platform[],
  ): Promise<HeartbeatReservation>;
  clearHeartbeatOwnership(platforms: readonly Platform[]): Promise<void>;
  clearHeartbeatOwnershipInBackground(platforms: readonly Platform[]): void;
  runWatchHeartbeat(): Promise<void>;
  requestPlatformHeartbeat(
    platform: Platform,
    settings: S,
    kind: HeartbeatAttemptKind,
    session?: WatchSession,
  ): Promise<void>;

  // twitchIntegrity.ts
  clearTwitchIntegrityAlarmBestEffort(emit?: EventEmitter): Promise<void>;
  loadStoredTwitchIntegrity(lifecycleGeneration: number, settingsTransitionGeneration: number): Promise<void>;
  runTwitchIntegrityRefresh(): Promise<void>;
  captureTwitchIntegrity(headers: IntegrityHeader[] | undefined, tabId?: number): Promise<void>;
  restoreTwitchIntegritySchedule(transitionIsCurrent: () => boolean): Promise<void>;
  prepareTwitchIntegrity(settings: S, signal: AbortSignal, tickContext: TickDiagnosticContext): Promise<boolean>;
  closeTwitchIntegrityLifecycle(reason: string): void;
  holdTwitchIntegrityForDisable(): () => void;
  reconcileTwitchIntegrityAfterCommit(): Promise<void>;
  startInitialTwitchIntegrityLoad(): void;
  awaitInitialTwitchIntegrityLoad(): Promise<void>;
  resetTwitchIntegrity(): void;

  // channelPoints.ts
  abortTwitchChannelPointsClaims(reason: string): void;
  abortIneligibleTwitchChannelPointsClaims(settings: EngineSettings, reason: string): void;
  clearTwitchChannelPointsAlarmBestEffort(): Promise<void>;
  reconcileTwitchChannelPointsAlarm(settings: S): Promise<void>;
  stopTwitchChannelPointsPush(emit: EventEmitter): Promise<void>;
  stopTwitchChannelPointsPushAndReport(): Promise<void>;
  rescheduleTwitchChannelPointsJob(): Promise<void>;
  stopTwitchChannelPointsPushInBackground(): void;
  twitchChannelPointsPushEpoch(): number;
  reconcileTwitchChannelPointsPushAfterCommit(
    committed: SchedulerState,
    since: number,
    settings: EngineSettings,
    adapter: PlatformAdapter,
    emit: EventEmitter,
  ): Promise<void>;
  registerTwitchChannelPointsEffects(executor: TickEffectExecutor): TickEffectExecutor;
  runTwitchChannelPointsClaim(): Promise<void>;

  // kickRuntime.ts
  abortKickChallengeClaims(reason: string): void;
  abortIneligibleKickChallengeClaims(settings: EngineSettings, reason: string): void;
  clearKickChallengeJobBestEffort(): Promise<void>;
  reconcileKickChallengeJob(settings: EngineSettings): Promise<void>;
  rescheduleKickChallengeJob(): Promise<void>;
  registerKickRuntimeEffects(executor: TickEffectExecutor): TickEffectExecutor;
  observeTickCycle(
    platforms: readonly Platform[],
    outcome: TickCycleOutcome,
    tickContext: TickDiagnosticContext,
  ): Promise<void>;
  endTickCycle(platform: Platform): void;
  runKickChallengeClaims(): Promise<void>;

  // authHealth.ts
  flattenedRefreshFailures(error: unknown): unknown[];
  refreshAuthHealth(
    platforms: Platform[],
    loadedSettings?: S,
    reportCompatibility?: boolean,
    signal?: AbortSignal,
    tickContext?: TickDiagnosticContext,
    tickAdapters?: Partial<Record<Platform, TickAdapterHandle<S>>>,
  ): Promise<void>;
  reportAuthSetupFailures(failures: readonly AuthProbeSetupError[], tickContext?: TickDiagnosticContext): Promise<void>;
  checkAuthHealth(platform: Platform): Promise<void>;
  invalidateAuthHealth(platform: Platform): Promise<void>;

  // manualWatch.ts
  handleTabRemoved(tabId: number): Promise<void>;
  resumeAfterManualClose(platform: Platform): Promise<void>;
  recordPlaybackTelemetry(
    message: Extract<CoreRuntimeMessage, { type: "playbackTelemetry" }>,
    senderTabId?: number,
    senderTabUrl?: string,
  ): Promise<void>;
  handleTabUpdated(tabId: number, url: string): Promise<void>;
  applyAdFocusForState(state: SchedulerState, emit: EventEmitter, platforms?: readonly Platform[]): Promise<void>;
  registerWatchTabEffectHandlers(executor: TickEffectExecutor): TickEffectExecutor;

  // supplementalSources.ts
  registerSupplementalTargetEffects(executor: TickEffectExecutor): TickEffectExecutor;
  getPlaybackControl(
    message: Extract<CoreRuntimeMessage, { type: "getPlaybackControl" }>,
    senderTabId?: number,
  ): Promise<PlaybackControl>;

  // claimService.ts
  clearDropClaimJobsBestEffort(): Promise<void>;
  reconcileDropClaimJobs(settings: EngineSettings): Promise<void>;
  rescheduleDropClaimJobs(): Promise<void>;
  registerRewardClaimEffects(executor: TickEffectExecutor): TickEffectExecutor;
  waitingClaimRewardIds(): Record<Platform, Set<string>>;
  recordWaitingClaimRewardIds(platform: Platform, rewardIds: ReadonlySet<string>): void;
  releaseRewardClaims(platform: Platform, rewardIds: Iterable<string>): void;
  abortIneligibleClaimOnlyOperations(settings: EngineSettings, reason: string): void;
  abortClaimOnlyOperations(reason: string): void;
  abortClaimHandoffs(platform?: Platform): void;
  runClaimHandoff(
    platform: Platform,
    justClaimedRewardIds?: readonly string[],
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<void>;
  claimRewardNow(message: Extract<CoreRuntimeMessage, { type: "claimReward" }>): Promise<RuntimeSnapshot<S>>;

  // Runtime message handlers, each in the module that owns what it changes
  // (#591). messages.ts only routes to them.
  setPlatformEnabled(message: Extract<CoreRuntimeMessage, { type: "setPlatformEnabled" | "setAutomation" }>): Promise<RuntimeSnapshot<S>>;
  saveSettingsFromMessage(message: Extract<CoreRuntimeMessage, { type: "saveSettings" }>): Promise<RuntimeSnapshot<S>>;
  updateIdleWatchlist(message: Extract<CoreRuntimeMessage, { type: "updateIdleWatchlist" }>): Promise<RuntimeSnapshot<S>>;
  resumeFarmingAfterManualClose(platform: Platform): Promise<RuntimeSnapshot<S>>;
  dismissCriticalFailure(platform: Platform): Promise<RuntimeSnapshot<S>>;
  searchCategories(message: Extract<CoreRuntimeMessage, { type: "searchCategories" }>): Promise<CategorySearchResult>;
  tickNow(): Promise<RuntimeSnapshot<S>>;
  runDropClaims(platform: Platform): Promise<void>;

  // discoverySignals.ts
  stopDiscoverySignalController(platform: Platform, emit: EventEmitter): Promise<void>;
  stopDiscoverySignalControllers(platforms: readonly Platform[], emit: EventEmitter): Promise<void>;
  stopDiscoverySignalControllersAndReport(platforms: readonly Platform[]): Promise<void>;
  stopDiscoverySignalControllersInBackground(platforms: readonly Platform[]): void;
  reconcileDiscoverySignalControllers(
    state: SchedulerState,
    settings: EngineSettings,
    adapters: Record<Platform, PlatformAdapter>,
    emit: EventEmitter,
    platforms?: readonly Platform[],
    since?: Partial<Record<Platform, number>>,
  ): Promise<void>;
  discoverySignalEpochs(platforms: readonly Platform[]): Partial<Record<Platform, number>>;
  reconcileDiscoverySignalsAfterCommit(
    committed: SchedulerState,
    since: Partial<Record<Platform, number>>,
    settings: EngineSettings,
    adapters: Record<Platform, PlatformAdapter>,
    emit: EventEmitter,
    platforms: readonly Platform[],
  ): Promise<void>;
  invalidateDiscoverySignalAdmission(platform: Platform): void;
  discoverySignalRefreshAllowed(platform: Platform, request: DiscoverySignalRefreshRequest): boolean;
  reserveDiscoverySignalAuthRefresh(platform: Platform): () => void;
  startPendingDiscoverySignalRefresh(platform: Platform): void;

  // discovery.ts
  selectionFingerprint(value: string): string;
  refreshDiscovery(
    platforms?: Platform[],
    bypassBackoff?: boolean,
    tickAdapters?: Partial<Record<Platform, TickAdapterHandle<S>>>,
  ): Promise<void>;
  discoverySnapshot(platform: Platform): Readonly<DiscoverySnapshotState>;
  selectionKey(platform: Platform, snapshot: DiscoverySnapshot, settings: S, state: SchedulerState): string;
  selectionIsForced(trigger: TickTrigger): boolean;
  selectionBypassesBackoff(trigger: TickTrigger): boolean;
  selectionBackoffDue(platform: Platform, state: SchedulerState): boolean;
  invalidateSelection(platform: Platform): void;
  prepareSelection(input: SelectionInput<S>): Promise<CommittedSelection>;
  reselectUnderLock(input: SelectionInput<S>): Promise<CommittedSelection>;
  selectionAlreadyCommitted(
    prepared: CommittedSelection,
    snapshot: DiscoverySnapshot,
    state: SchedulerState,
    platform: Platform,
  ): SnapshotSelectionResult | undefined;

  // tickAdmission.ts
  tickTriggerSummary(reasons: TickRequest["reasons"]): string;
  cancelPendingTick(platform: Platform): void;
  retainCurrentTickReasons(platform: Platform, request: TickRequest): boolean;
  requestTickBatch(
    platforms: Platform[] | undefined,
    trigger: TickTrigger,
    discoverySignal?: DiscoverySignalRefreshRequest,
  ): TickBatch;
  tick(
    platforms?: Platform[],
    trigger?: TickTrigger,
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<ClaimedRewards>;
  abortActiveTicks(reason: string): void;
  tickInBackground(platforms: Platform[] | undefined, trigger: TickTrigger, onCompleted?: () => void): void;
  settleBackgroundWork(): Promise<void>;
  markPlatformsStarting(platforms: readonly Platform[], transitionIsCurrent?: () => boolean): Promise<void>;
  tickAndHandOff(platforms?: Platform[], trigger?: TickTrigger): Promise<SchedulerState | undefined>;
  completeTickAndHandOff(batch: TickBatch): Promise<SchedulerState | undefined>;

  // tickRun.ts
  tickPlatform(
    platform: Platform,
    trigger: TickTrigger,
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<readonly [Platform, string[]]>;

  // settingsTransitions.ts
  normalizeStartupSettings(): Promise<S>;
  commitSettings(
    update: (current: S) => SettingsPatch,
    options?: SettingsCommitOptions,
  ): Promise<PreparedSettingsCommit<S>>;

  // lifecycle.ts
  ensureAlarm(): Promise<void>;
  ensureCadenceJobs(settings?: S): Promise<void>;
  rescheduleTickJobs(): Promise<void>;
  ensureInstalledAt(installedAt?: string): Promise<void>;
  reconcileStartup(): Promise<S>;
  handleStartup(): Promise<void>;
  snapshot(): Promise<RuntimeSnapshot<S>>;
  shutdown(): void;
  prepareForHostReset(resetHostStorage?: () => Promise<void>): Promise<void>;

  // messages.ts
  handleMessage(
    message: CoreRuntimeMessage,
    sender?: { tab?: { id?: number; url?: string } },
  ): Promise<RuntimeSnapshot<S> | PlaybackControl | CategorySearchResult | void>;
}
