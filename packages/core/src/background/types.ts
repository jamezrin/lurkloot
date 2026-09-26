import type { CategorySearchResult, CoreRuntimeMessage, PlaybackControl, RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { EngineSettings, ManagedWatchTab, Platform, PlaybackTelemetry, SchedulerState, SupplementalWatchTarget, TablessHeartbeatCadence, WatchSession, WatchSourceId } from "@lurkloot/shared/models";
import type { DiagnosticEvent, EngineEvent, EventEmitter, EventReporter } from "@lurkloot/shared/events";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import type { CompatibilityResolution, ResolvedCompatibility } from "@lurkloot/shared/compatibility";
import {
  selectWatchTargetFromSnapshot,
  type SnapshotSelectionResult,
  type StopPageContextTabs,
} from "../core/scheduler";
import type { TwitchIntegrityRequest } from "../core/tabs";
import type { IntegrityHeader, TwitchIntegrity } from "../core/twitchIntegrity";
import type { PlatformAdapter } from "../platforms/adapter";
import type { TablessWatchController } from "../core/tablessWatch";
import type { DiscoverySignalController } from "../core/discoverySignals";
import type { DiscoverySnapshot, DiscoverySnapshotState } from "../core/discoverySnapshot";
import { AuthProbeSetupError } from "./errors";
import type { CommitGuard, CommitOptions, CommitResult, LockTracker, PreparedSettingsCommit } from "./stateTransaction";

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
  | "unknown";

export type TickDiagnosticContext = Required<Pick<
  DiagnosticEvent,
  "globalTickId" | "platformTickId"
>>;
export type CredentialAvailability =
  | { status: "available" }
  | { status: "missing" }
  | { status: "unavailable" };

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
  readonly promise: Promise<HeartbeatFallback | undefined>;
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

export interface HeartbeatPublicationLease {
  published?: CommittedHeartbeatContext;
  readonly admissionReady: Promise<void>;
  readonly markPublished: (context: CommittedHeartbeatContext) => void;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

export interface HeartbeatContextPublication {
  accepted: boolean;
  cadence?: TablessHeartbeatCadence;
  committed?: CommittedHeartbeatContext;
  replaced?: TablessWatchController;
}

export type HeartbeatContextPublicationDecision = HeartbeatContextPublication | {
  waitFor: Promise<void>;
};

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
  // Discovery reserves this before starting, switching, or stopping a watcher
  // and holds it until the corresponding scheduler state has been persisted.
  // Recovery waits while a new owner is unpublished, while a heartbeat may use
  // the complete published context before persistence finishes. Its result then
  // waits for lease settlement outside provider I/O and every lock.
  publicationLease?: HeartbeatPublicationLease;
  inFlight?: HeartbeatAttempt;
  // Reserved only after transport completes. Context publishers wait for this
  // promise outside the lane, so either publication wins and rejects the old
  // result or the current result persists before publication becomes visible.
  resultCommit?: HeartbeatResultCommit;
  recoveryCommit?: HeartbeatRecoveryCommit;
  generationHighWater?: number;
  lastCompletedGeneration?: number;
  lastCompletedContextKey?: string;
  coalescedWithoutAttempt: number;
}

export interface SettingsCommitOptions<S> {
  // Called with the stored settings the commit read, before it saves.
  afterLoad?(previous: S): void;
  // Called once the new settings are saved, before the settings lock is released.
  afterPersist?(settings: S): void;
}

// Generic over the host's settings type `S`, which must satisfy the engine
// contract (EngineSettings). The extension parametrizes it with its fuller
// ExtensionSettings (load/save round-trip the host-only fields); the CLI uses the
// bare EngineSettings. The engine itself only ever reads EngineSettings fields.
export interface BackgroundControllerDeps<S extends EngineSettings = EngineSettings> {
  loadSettings(): Promise<S>;
  saveSettings(settings: S): Promise<void>;
  loadState(): Promise<SchedulerState>;
  saveState(state: SchedulerState): Promise<void>;
  authProbeTimeoutMs?: number;
  reportEvents?: EventReporter;
  createAlarm(
    name: string,
    options: { periodInMinutes: number } | { when: number },
  ): Promise<void>;
  getAlarm?(name: string): Promise<{ scheduledTime: number } | undefined>;
  clearAlarm?(name: string): Promise<boolean>;
  ensureTwitchIntegrity?(
    emit: EventEmitter,
    request?: TwitchIntegrityRequest,
  ): Promise<boolean>;
  cancelTwitchIntegrityAcquisition?(reason?: unknown): void;
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
  checkCredentialAvailability?(platform: Platform): Promise<CredentialAvailability>;
  createNotification?(notification: { title: string; message: string }): Promise<void>;
  translate?(key: string, substitutions?: string | string[]): string | Promise<string>;
  closeManagedTabs?(tabs: ManagedWatchTab[]): Promise<void>;
  // Tab-mode ad focus. The host (extension) owns the focus policy (adFocusMode),
  // so the engine only reports whether an ad is active for a given watch tab.
  applyAdFocus?(platform: Platform, tabId: number | undefined, adActive: boolean, emit: EventEmitter): Promise<void>;
  // Tab-mode playback policy the host supplies to managed watch tabs. Defaults to
  // keeping videos unmuted when the host does not provide it.
  loadTabPlaybackPolicy?(): Promise<{ keepVideosUnmuted: boolean }>;
  // Applies a popup settings patch to the host's full settings. Host-only; the
  // CLI never sends settings-mutating messages, so it can omit this.
  applySettingsPatch?(current: S, patch: SettingsPatch): S;
  loadTwitchIntegrity?(): Promise<TwitchIntegrity | undefined>;
  saveTwitchIntegrity?(value: TwitchIntegrity): Promise<void>;
  // Browser-bound page-context tab teardown, injected into the scheduler tick.
  // Omitted in headless/test runs, where the scheduler forgets contexts from
  // state only (see runSchedulerTick / StopPageContextTabs).
  stopPageContextTabs?: StopPageContextTabs;
  // Test instrumentation for the state transaction's lock-order and locked-I/O
  // checks (stateTransaction.ts). Hosts leave it out.
  lockTracker?: LockTracker;
  reconcilePageContextRecovery?(
    platform: Platform,
    settings: S,
    options: { countBackgroundSuccess: boolean },
    emit: EventEmitter,
  ): Promise<boolean>;
  discardPageContextRecoveryEvidence?(platform: Platform): void;
  selectWatchTarget?: typeof selectWatchTargetFromSnapshot;
  selectSupplementalWatchTarget?(platform: Platform, state: SchedulerState, settings: S, signal?: AbortSignal, source?: WatchSourceId): Promise<SupplementalWatchTarget | undefined>;
  // Delay used by the bounded post-claim handoff. Injected so tests can drive
  // the loop deterministically instead of racing real timers. Resolves early
  // (without throwing) when the signal aborts, so callers check `signal.aborted`
  // after awaiting rather than catching.
  wait?(ms: number, signal: AbortSignal): Promise<void>;
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

  // heartbeat.ts
  releaseHeartbeatPublicationLease(platform: Platform, lease: HeartbeatPublicationLease): Promise<void>;
  cancelHeartbeatPublicationLeases(platforms: readonly Platform[]): Promise<void>;
  reconcileTablessWatchers(
    state: SchedulerState,
    settings: EngineSettings,
    adapters: Record<Platform, PlatformAdapter>,
    emit: EventEmitter,
    platforms?: Platform[],
  ): Promise<Array<readonly [Platform, HeartbeatPublicationLease]>>;
  clearHeartbeatOwnership(platforms: readonly Platform[]): Promise<void>;
  clearHeartbeatOwnershipInBackground(platforms: readonly Platform[]): void;
  runWatchHeartbeat(): Promise<void>;
  requestPlatformHeartbeat(
    platform: Platform,
    settings: S,
    kind: HeartbeatAttemptKind,
    session?: WatchSession,
  ): Promise<HeartbeatFallback | undefined>;

  // twitchIntegrity.ts
  clearTwitchIntegrityAlarmBestEffort(emit?: EventEmitter): Promise<void>;
  loadStoredTwitchIntegrity(lifecycleGeneration: number, settingsTransitionGeneration: number): Promise<void>;
  runTwitchIntegrityRefresh(): Promise<void>;
  captureTwitchIntegrity(headers: IntegrityHeader[] | undefined, tabId?: number): Promise<void>;
  restoreTwitchIntegritySchedule(transitionIsCurrent: () => boolean): Promise<void>;
  prepareTwitchIntegrity(settings: S, signal: AbortSignal, tickContext: TickDiagnosticContext): Promise<boolean>;
  closeTwitchIntegrityLifecycle(reason: string): void;
  reconcileTwitchIntegrityLifecycle(enabled: boolean | undefined): void;

  // channelPoints.ts
  clearTwitchChannelPointsAlarmBestEffort(): Promise<void>;
  reconcileTwitchChannelPointsAlarm(settings: S): Promise<void>;
  stopTwitchChannelPointsPush(emit: EventEmitter): Promise<void>;
  stopTwitchChannelPointsPushAndReport(): Promise<void>;
  stopTwitchChannelPointsPushInBackground(): void;
  reconcileTwitchChannelPointsPush(
    settings: EngineSettings,
    state: SchedulerState,
    adapter: PlatformAdapter,
    emit: EventEmitter,
  ): Promise<void>;
  runTwitchChannelPointsClaim(): Promise<void>;

  // kickChallenges.ts
  reconcilePageContextRecoveryAfterPersist(
    platforms: readonly Platform[],
    state: SchedulerState,
    settings: S,
    backgroundSuccessPlatforms: ReadonlySet<Platform>,
    tickContext: TickDiagnosticContext,
  ): Promise<void>;
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
  getPlaybackControl(
    message: Extract<CoreRuntimeMessage, { type: "getPlaybackControl" }>,
    senderTabId?: number,
  ): Promise<PlaybackControl>;

  // claims.ts
  clearManualWatchClaimAlarmsBestEffort(): Promise<void>;
  reconcileManualWatchClaimAlarms(settings: EngineSettings): Promise<void>;
  abortIneligibleClaimOnlyOperations(settings: EngineSettings, reason: string): void;
  abortClaimOnlyOperations(reason: string): void;
  abortClaimHandoffs(platform?: Platform): void;
  runClaimHandoff(
    platform: Platform,
    justClaimedRewardIds?: readonly string[],
    onPersisted?: (state: SchedulerState) => void,
  ): Promise<void>;
  claimRewardNow(message: Extract<CoreRuntimeMessage, { type: "claimReward" }>): Promise<RuntimeSnapshot<S>>;
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
    platforms?: Platform[],
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
    options?: SettingsCommitOptions<S>,
  ): Promise<PreparedSettingsCommit<S>>;

  // lifecycle.ts
  ensureAlarm(): Promise<void>;
  ensureSchedulerAlarms(periodInMinutes: number): Promise<void>;
  ensureInstalledAt(installedAt?: string): Promise<void>;
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
