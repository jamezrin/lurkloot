import type { EngineSettings } from "@lurkloot/shared/models";
import { createAuthHealth } from "./authHealth";
import { createChannelPoints } from "./channelPoints";
import { createClaimService } from "./claimService";
import {
  createDiscoverySignalSlice,
  createLifecycleSlice,
  createReportingSlice,
  createPlatformPolicySlice,
  createTabRegistrySlice,
  createTickAdmissionSlice,
} from "./context";
import { createDiscovery } from "./discovery";
import { createDiscoverySignals } from "./discoverySignals";
import { createHeartbeatCoordinator } from "./heartbeat";
import { createKickRuntime } from "./kickRuntime";
import { createLifecycle } from "./lifecycle";
import { createManualWatch } from "./manualWatch";
import { createMessageHandler } from "./messages";
import { createReporting } from "./reporting";
import { createSettingsTransitions } from "./settingsTransitions";
import { createStateCommit } from "./stateCommit";
import { createStateTransaction } from "./stateTransaction";
import { createSupplementalSources } from "./supplementalSources";
import { createTickAdmission } from "./tickAdmission";
import { createTickRun } from "./tickRun";
import { createTwitchIntegrity } from "./twitchIntegrity";
import { assertHostCapabilities, type BackgroundHostPorts, type TabEventsPort } from "./hostPorts";
import { capabilityScopedJobs, runBackgroundJob } from "./jobs";
import type { ControllerCalls } from "./types";

export {
  ALARM_NAME,
  TWITCH_ALARM_NAME,
  KICK_ALARM_NAME,
  WATCH_ALARM_NAME,
  WATCH_ALARM_PERIOD_MINUTES,
  TWITCH_CHANNEL_POINTS_ALARM_NAME,
  TWITCH_DROP_CLAIMS_ALARM_NAME,
  KICK_DROP_CLAIMS_ALARM_NAME,
  KICK_CHALLENGES_ALARM_NAME,
  TWITCH_INTEGRITY_ALARM_NAME,
  TWITCH_INTEGRITY_REFRESH_LEAD_MS,
  TWITCH_INTEGRITY_REFRESH_JITTER_MAX_MS,
} from "./constants";
export { isRankingOnlyPatch, LockOrderError, settingsPatchEffects, TRANSACTION_LOCKS } from "./stateTransaction";
export type {
  CommitHook,
  CommitResult,
  CommittedChange,
  LockTracker,
  SettingsEffect,
  SettingsEffects,
  TransactionLock,
} from "./stateTransaction";
export type { ClaimedRewards, TickTrigger } from "./types";
export {
  assertHostCapabilities,
  CLI_CAPABILITIES,
  EXTENSION_CAPABILITIES,
  HostCapabilityMismatchError,
} from "./hostPorts";
export type {
  AdaptersPort,
  BackgroundHostPorts,
  BrowserTabsPort,
  CredentialAvailability,
  CredentialsPort,
  EventsPort,
  HostCapabilities,
  PageContextPort,
  PageContextRecoveryOptions,
  TabEventsPort,
  StoragePort,
  SupplementalSourcesPort,
  TestingPorts,
  TwitchHostPorts,
  TwitchIntegrityPort,
  WatchTabPort,
} from "./hostPorts";
export { BACKGROUND_JOBS, jobIsInert, MIN_JOB_PERIOD_MINUTES, runBackgroundJob } from "./jobs";
export type { BackgroundJob, JobRunner, JobSchedule, JobSchedulerPort, ScheduledJob } from "./jobs";

// Dispatches a fired browser alarm to its job (#593). Kept for hosts that
// register an alarm listener; it is the controller's runJob.
export function createBackgroundAlarmListener(controller: { runJob(name: string): Promise<void> }) {
  return (alarm: { name: string }): void => {
    void controller.runJob(alarm.name);
  };
}

export function createBackgroundController<S extends EngineSettings = EngineSettings>(hostPorts: BackgroundHostPorts<S>) {
  assertHostCapabilities(hostPorts);
  const { capabilities } = hostPorts;
  // Jobs a host cannot run are never scheduled (jobs.ts).
  const ports: BackgroundHostPorts<S> = { ...hostPorts, jobs: capabilityScopedJobs(hostPorts.jobs, capabilities) };
  const tabRegistry = createTabRegistrySlice(hostPorts.tabRegistry);
  // Owns the locks, commits and after-commit hooks (#585).
  const transaction = createStateTransaction({ ...ports.storage, lockTracker: ports.testing?.lockTracker, tabRegistry });
  const reportingSlice = createReportingSlice();
  const signalSlice = createDiscoverySignalSlice();
  const tickSlice = createTickAdmissionSlice();
  const policySlice = createPlatformPolicySlice<S>();
  const lifecycleSlice = createLifecycleSlice();
  // Each module takes the slices it uses and the calls it makes into other
  // modules. The calls resolve through `calls` once every module exists.
  const calls = {} as ControllerCalls<S>;
  const discovery = createDiscovery(ports, { lifecycleSlice }, calls);
  Object.assign(calls, {
    ...createReporting(ports, { reportingSlice }, calls),
    ...createStateCommit(transaction, calls),
    ...createHeartbeatCoordinator(ports, transaction, { lifecycleSlice, tabRegistry }, calls),
    ...createTwitchIntegrity(ports, { lifecycleSlice, tabRegistry, policySlice }, calls),
    ...createChannelPoints(ports, transaction, { lifecycleSlice }, calls),
    ...createKickRuntime(ports, transaction, { lifecycleSlice }, calls),
    ...createAuthHealth(ports, calls),
    ...createManualWatch(ports, { tabRegistry, lifecycleSlice }, calls),
    ...createSupplementalSources(ports),
    ...createClaimService(ports, transaction, { lifecycleSlice }, calls),
    ...createDiscoverySignals(ports, transaction, { signalSlice, lifecycleSlice }, calls),
    ...discovery,
    ...createTickAdmission(ports, transaction, { tickSlice, lifecycleSlice }, calls),
    ...createTickRun(ports, transaction, { tickSlice, tabRegistry, policySlice }, calls),
    ...createSettingsTransitions(transaction, { policySlice }, calls),
    ...createLifecycle(ports, { lifecycleSlice, tabRegistry }, calls),
    ...createMessageHandler(calls),
  } satisfies ControllerCalls<S>);

  // Prime the in-memory integrity token from storage (twitchIntegrity.ts).
  calls.startInitialTwitchIntegrityLoad();

  // Runs the job a host's scheduler fired; unknown and inert jobs do nothing.
  async function runJob(name: string): Promise<void> {
    await runBackgroundJob(name, calls, capabilities);
  }

  const api = {
    capabilities,
    runJob,
    ensureAlarm: calls.ensureAlarm,
    ensureCadenceJobs: () => calls.ensureCadenceJobs(),
    ensureInstalledAt: calls.ensureInstalledAt,
    reconcileStartup: calls.reconcileStartup,
    handleStartup: calls.handleStartup,
    // An extension update found Twitch on the HLS heartbeat without the video
    // CDN grant. The popup asks for that grant the next time Twitch is turned on.
    disableTwitchUntilHlsHostGranted: () => calls.setPlatformEnabled(
      { type: "setAutomation", platform: "twitch", enabled: false },
      "missing-hls-host",
    ),
    ...({
      handleTabRemoved: calls.handleTabRemoved,
      handleTabUpdated: calls.handleTabUpdated,
    } satisfies TabEventsPort),
    handleMessage: calls.handleMessage,
    resumeAfterManualClose: calls.resumeAfterManualClose,
    captureTwitchIntegrity: calls.captureTwitchIntegrity,
    runTwitchIntegrityRefresh: calls.runTwitchIntegrityRefresh,
    checkAuthHealth: calls.checkAuthHealth,
    invalidateAuthHealth: calls.invalidateAuthHealth,
    tick: calls.tick,
    tickAndHandOff: calls.tickAndHandOff,
    refreshDiscovery: calls.refreshDiscovery,
    discoverySnapshot: calls.discoverySnapshot,
    runWatchHeartbeat: calls.runWatchHeartbeat,
    runTwitchChannelPointsClaim: calls.runTwitchChannelPointsClaim,
    runDropClaims: calls.runDropClaims,
    runKickChallengeClaims: calls.runKickChallengeClaims,
    runClaimHandoff: calls.runClaimHandoff,
    abortClaimHandoffs: calls.abortClaimHandoffs,
    shutdown: calls.shutdown,
    prepareForHostReset: calls.prepareForHostReset,
    settleBackgroundWork: calls.settleBackgroundWork,
    // Reports events as this controller run, for host work that outlives the
    // operation that started it (the shared Twitch integrity mint).
    reportEvents: calls.reportBestEffort,
    // Registers a hook called after each accepted settings or scheduler-state
    // commit (stateTransaction.ts). Returns the unregister function.
    onCommit: transaction.onCommit,
  };
  // Every entry point is a host event, so it starts outside any lock, even when
  // it is called from inside a host callback the controller is awaiting.
  return Object.fromEntries(Object.entries(api).map(([name, entry]) => [
    name,
    typeof entry === "function"
      ? (...args: unknown[]) => transaction.detach(() => (entry as (...args: unknown[]) => unknown)(...args))
      : entry,
  ])) as typeof api;
}
