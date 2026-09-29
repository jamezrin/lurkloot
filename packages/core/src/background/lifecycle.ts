import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { EngineSettings, ManagedWatchTab, Platform, SchedulerState, WatchSession } from "@lurkloot/shared/models";
import { isFarmingActive } from "@lurkloot/shared/settings";
import { registerManagedPageContextTabs } from "../core/tabRegistry";
import { ALARM_NAME, KICK_ALARM_NAME, PLATFORMS, TWITCH_ALARM_NAME } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import { emitHostCallbackError, farmingLifecycleEvents } from "./helpers";
import type { BackgroundHostPorts } from "./hostPorts";
import type { ControllerCalls } from "./types";

function staleStartupCleanup(state: SchedulerState, preservePageContexts = false): {
  hasStaleSession: boolean;
  managedTabs: ManagedWatchTab[];
  state: SchedulerState;
} {
  let hasStaleSession = false;
  const managedTabs = new Map<number, ManagedWatchTab>();
  const sessions = { ...state.sessions };

  for (const platform of ["twitch", "kick"] as Platform[]) {
    const session = state.sessions[platform];
    const managedTab = state.managedWatchTabs?.[platform];
    const managedPageContextTab = state.managedPageContextTabs?.[platform];
    if (managedTab?.ownedByExtension) managedTabs.set(managedTab.tabId, managedTab);

    if (session.status === "watching" || session.tabId != null || managedTab || (!preservePageContexts && managedPageContextTab)) {
      hasStaleSession = true;
      sessions[platform] = pausedStartupSession(session);
    }
  }

  return {
    hasStaleSession,
    managedTabs: [...managedTabs.values()],
    state: {
      ...state,
      sessions,
      managedWatchTabs: {},
      managedPageContextTabs: preservePageContexts ? state.managedPageContextTabs : {},
    },
  };
}

function pausedStartupSession(session: WatchSession): WatchSession {
  return {
    ...session,
    status: "paused",
    channel: undefined,
    campaignId: undefined,
    rewardId: undefined,
    tabId: undefined,
    tabManagedByExtension: undefined,
    playback: undefined,
    playbackChecks: 0,
    errorChecks: 0,
    retryAfter: undefined,
    message: "Browser restarted; farming paused",
    reasonCode: "runtime_restart",
  };
}

// Startup, jobs, snapshot, shutdown and host reset.
export function createLifecycle<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  { discoverySlice, tickSlice, settingsSlice, lifecycleSlice, tabRegistry }: Pick<ControllerSlices<S>,
    | "tabRegistry"
    | "discoverySlice"
    | "tickSlice"
    | "settingsSlice"
    | "lifecycleSlice"
  >,
  calls: Pick<ControllerCalls<S>,
    | "resetTwitchIntegrity"
    | "abortActiveTicks"
    | "abortClaimHandoffs"
    | "abortClaimOnlyOperations"
    | "abortKickChallengeClaims"
    | "abortTwitchChannelPointsClaims"
    | "cancelHeartbeatPublicationLeases"
    | "ensureHeartbeatJob"
    | "clearHeartbeatOwnership"
    | "clearHeartbeatOwnershipInBackground"
    | "clearKickChallengeJobBestEffort"
    | "clearDropClaimJobsBestEffort"
    | "clearTwitchChannelPointsAlarmBestEffort"
    | "clearTwitchIntegrityAlarmBestEffort"
    | "closeTwitchIntegrityLifecycle"
    | "invalidateDiscoverySignalAdmission"
    | "invalidateSelection"
    | "normalizeStartupSettings"
    | "persistAndReport"
    | "reconcileKickChallengeJob"
    | "reconcileDropClaimJobs"
    | "reconcileTwitchChannelPointsAlarm"
    | "refreshAuthHealth"
    | "reportBestEffort"
    | "saveOperationalState"
    | "stopDiscoverySignalControllersAndReport"
    | "stopDiscoverySignalControllersInBackground"
    | "stopTwitchChannelPointsPushAndReport"
    | "stopTwitchChannelPointsPushInBackground"
    | "tick"
    | "withEventCollector"
    | "withSettingsLock"
    | "withStateLock"
  >,
): Pick<ControllerCalls<S>,
  | "ensureAlarm"
  | "ensureCadenceJobs"
  | "rescheduleTickJobs"
  | "ensureInstalledAt"
  | "reconcileStartup"
  | "handleStartup"
  | "snapshot"
  | "shutdown"
  | "prepareForHostReset"
> {
  const {
    resetTwitchIntegrity,
    abortActiveTicks,
    abortClaimHandoffs,
    abortClaimOnlyOperations,
    abortKickChallengeClaims,
    abortTwitchChannelPointsClaims,
    cancelHeartbeatPublicationLeases,
    ensureHeartbeatJob,
    clearHeartbeatOwnership,
    clearHeartbeatOwnershipInBackground,
    clearKickChallengeJobBestEffort,
    clearDropClaimJobsBestEffort,
    clearTwitchChannelPointsAlarmBestEffort,
    clearTwitchIntegrityAlarmBestEffort,
    closeTwitchIntegrityLifecycle,
    invalidateDiscoverySignalAdmission,
    invalidateSelection,
    normalizeStartupSettings,
    persistAndReport,
    reconcileKickChallengeJob,
    reconcileDropClaimJobs,
    reconcileTwitchChannelPointsAlarm,
    refreshAuthHealth,
    reportBestEffort,
    saveOperationalState,
    stopDiscoverySignalControllersAndReport,
    stopDiscoverySignalControllersInBackground,
    stopTwitchChannelPointsPushAndReport,
    stopTwitchChannelPointsPushInBackground,
    tick,
    withEventCollector,
    withSettingsLock,
    withStateLock,
  } = lateBound(calls);

  async function ensureAlarm(): Promise<void> {
    const settings = await ports.storage.loadSettings();
    await ensureCadenceJobs(settings);
    await reconcileTwitchChannelPointsAlarm(settings);
    await reconcileDropClaimJobs(settings);
    await reconcileKickChallengeJob(settings);
    if (settings.autoStartDropFarming && isFarmingActive(settings)) {
      await tick(undefined, "install");
    } else {
      await refreshAuthHealth(PLATFORMS, settings);
    }
  }

  async function ensureSchedulerAlarms(periodInMinutes: number): Promise<void> {
    await ports.jobs.cancel(ALARM_NAME);
    await Promise.all([
      ports.jobs.ensure(TWITCH_ALARM_NAME, { periodInMinutes }),
      ports.jobs.ensure(KICK_ALARM_NAME, { periodInMinutes }),
    ]);
  }

  // The per-platform tick jobs at the poll interval and the 1-minute watch
  // heartbeat job: the cadence every host runs.
  async function ensureCadenceJobs(settings?: S): Promise<void> {
    const { pollIntervalMinutes } = settings ?? await ports.storage.loadSettings();
    await ensureSchedulerAlarms(pollIntervalMinutes);
    await ensureHeartbeatJob();
  }

  // Re-anchors the tick jobs after a settings commit, with no lock held.
  // Reschedules queue behind each other and each reads the settings when it
  // runs, so the last one applies the latest poll interval even when commits
  // finish out of order.
  let tickJobsReschedule: Promise<void> = Promise.resolve();
  function rescheduleTickJobs(): Promise<void> {
    const run = tickJobsReschedule.then(async () => {
      const { pollIntervalMinutes } = await ports.storage.loadSettings();
      await ensureSchedulerAlarms(pollIntervalMinutes);
    });
    tickJobsReschedule = run.catch(() => undefined);
    return run;
  }

  async function ensureInstalledAt(installedAt = new Date().toISOString()): Promise<void> {
    await withStateLock(async () => {
      const state = await ports.storage.loadState();
      if (state.installedAt) return;
      await saveOperationalState({ ...state, installedAt });
    });
  }

  // The restart reconciliation every host runs when its process starts
  // (#593): the extension on browser startup, the CLI on every process start.
  // It re-ensures the jobs, releases heartbeat ownership held by the previous
  // process, pauses sessions it left watching, releases its tabs, and returns
  // the normalized settings. It does not resume farming.
  async function reconcileStartup(): Promise<S> {
    // A restart kills the watchers a handoff would transmit through, so leave
    // no loop running against them.
    abortClaimHandoffs();
    const settings = await ports.storage.loadSettings();
    await ensureCadenceJobs(settings);
    await reconcileTwitchChannelPointsAlarm(settings);
    await reconcileDropClaimJobs(settings);
    await reconcileKickChallengeJob(settings);
    // A restart kills any in-memory watchers; atomically release their lane
    // ownership before host cleanup, then let tick() rebuild fresh instances.
    await clearHeartbeatOwnership(PLATFORMS);

    const preservePageContexts = isFarmingActive(settings) && settings.autoStartDropFarming;
    const { state, cleanup } = await withStateLock(async () => {
      const state = await ports.storage.loadState();
      registerManagedPageContextTabs(tabRegistry, preservePageContexts ? state.managedPageContextTabs ?? {} : {});
      const cleanup = staleStartupCleanup(state, preservePageContexts);
      if (cleanup.hasStaleSession) {
        const restartEvents = farmingLifecycleEvents(state, cleanup.state);
        await persistAndReport(cleanup.state, restartEvents);
      }
      return { state, cleanup };
    });
    if (!cleanup.hasStaleSession) return normalizeStartupSettings();

    const { tabs } = ports;
    if (tabs && cleanup.managedTabs.length > 0) {
      // Tabs left over from before the host restarted.
      await tabs.watch.closeManaged(cleanup.managedTabs, "host-restart");
    }
    if (!preservePageContexts && tabs && Object.keys(state.managedPageContextTabs ?? {}).length > 0) {
      await withEventCollector(async (emit, events) => {
        await tabs.pageContexts.release(state.managedPageContextTabs ?? {}, {
          platforms: ["twitch", "kick"],
          reason: "runtime_restart",
          emit,
        });
        await reportBestEffort(events);
      });
    }

    return normalizeStartupSettings();
  }

  // The extension's startup: reconcile, then resume farming when the settings
  // ask for it. The CLI resumes through its own tick driver instead.
  async function handleStartup(): Promise<void> {
    const settings = await reconcileStartup();
    if (settings.autoStartDropFarming && isFarmingActive(settings)) {
      await tick(undefined, "startup");
    } else {
      await refreshAuthHealth(PLATFORMS, settings, true);
    }
  }

  async function snapshot(): Promise<RuntimeSnapshot<S>> {
    return {
      settings: await ports.storage.loadSettings(),
      state: await ports.storage.loadState(),
    };
  }

  function shutdown(): void {
    lifecycleSlice.controllerShutdown = true;
    for (const platform of PLATFORMS) {
      discoverySlice.discoveryLanes[platform].stop();
      invalidateSelection(platform);
    }
    lifecycleSlice.observersOpen = false;
    for (const platform of PLATFORMS) invalidateDiscoverySignalAdmission(platform);
    settingsSlice.twitchSettingsTransitionGeneration += 1;
    abortActiveTicks("Controller shutdown");
    closeTwitchIntegrityLifecycle("Controller shutdown");
    abortClaimOnlyOperations("Controller shutdown");
    abortKickChallengeClaims("Controller shutdown");
    abortTwitchChannelPointsClaims("Controller shutdown");
    void clearTwitchIntegrityAlarmBestEffort();
    void clearTwitchChannelPointsAlarmBestEffort();
    void clearDropClaimJobsBestEffort();
    void clearKickChallengeJobBestEffort();
    abortClaimHandoffs();
    void cancelHeartbeatPublicationLeases(PLATFORMS);
    clearHeartbeatOwnershipInBackground(PLATFORMS);
    stopDiscoverySignalControllersInBackground(PLATFORMS);
    stopTwitchChannelPointsPushInBackground();
  }

  async function prepareForHostReset(resetHostStorage?: () => Promise<void>): Promise<void> {
    tickSlice.tickAdmissionSuspended = true;
    lifecycleSlice.observersOpen = false;
    try {
      for (const platform of PLATFORMS) invalidateDiscoverySignalAdmission(platform);
      settingsSlice.twitchSettingsTransitionGeneration += 1;
      for (const platform of PLATFORMS) {
        discoverySlice.discoveryLanes[platform].invalidate();
        invalidateSelection(platform);
      }
      abortActiveTicks("Host reset");
      closeTwitchIntegrityLifecycle("Host reset");
      abortClaimOnlyOperations("Host reset");
      abortKickChallengeClaims("Host reset");
      abortTwitchChannelPointsClaims("Host reset");
      await stopDiscoverySignalControllersAndReport(PLATFORMS);
      await stopTwitchChannelPointsPushAndReport();
      await clearTwitchIntegrityAlarmBestEffort();
      await clearTwitchChannelPointsAlarmBestEffort();
      await clearDropClaimJobsBestEffort();
      await clearKickChallengeJobBestEffort();
      abortClaimHandoffs();
      await clearHeartbeatOwnership(PLATFORMS);
      // The locks cover only the reset itself. The tabs the reset state no
      // longer holds are closed afterwards, with no lock held (#598): tick
      // admission stays suspended until then, so nothing can reopen them.
      const state = await withSettingsLock(() => withStateLock(async () => {
        const previous = await ports.storage.loadState();
        registerManagedPageContextTabs(tabRegistry, {});
        resetTwitchIntegrity();
        await resetHostStorage?.();
        return previous;
      }));
      const { tabs } = ports;
      if (tabs) {
        // The reset has already committed, so a tab the host cannot close is
        // reported and skipped rather than failing the reset.
        await withEventCollector(async (emit, events) => {
          const attempt = async (platforms: readonly Platform[], message: string, operation: () => unknown) => {
            try {
              await operation();
            } catch (error) {
              for (const platform of platforms) emitHostCallbackError(emit, platform, error, message);
            }
          };
          const managedTabs = Object.values(state.managedWatchTabs ?? {}).filter((tab): tab is ManagedWatchTab => tab?.ownedByExtension === true);
          if (managedTabs.length > 0) {
            await attempt([...new Set(managedTabs.map((tab) => tab.platform))], "Could not close managed watch tabs", () => tabs.watch.closeManaged(managedTabs, "extension-cleanup"));
          }
          for (const platform of PLATFORMS) {
            await attempt([platform], "Could not release ad focus", () => tabs.watch.applyAdFocus(platform, state.sessions[platform].tabId, false, emit));
            await attempt([platform], "Could not stop watch tab", () => tabs.watch.stop(state.sessions[platform], { closeManagedTabs: true }, emit));
          }
          await attempt(PLATFORMS, "Could not stop page contexts", () => tabs.pageContexts.release(state.managedPageContextTabs ?? {}, {
            platforms: PLATFORMS,
            reason: "automation_disabled",
            emit,
          }));
          await reportBestEffort(events);
        });
      }
    } finally {
      if (!lifecycleSlice.controllerShutdown) {
        lifecycleSlice.observersOpen = true;
        tickSlice.tickAdmissionSuspended = false;
      }
    }
  }

  return {
    ensureAlarm,
    ensureCadenceJobs,
    rescheduleTickJobs,
    ensureInstalledAt,
    reconcileStartup,
    handleStartup,
    snapshot,
    shutdown,
    prepareForHostReset,
  };
}
