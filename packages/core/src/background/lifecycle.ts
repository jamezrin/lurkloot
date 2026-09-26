import type { RuntimeSnapshot } from "@lurkloot/shared/messages";
import type { EngineSettings, ManagedWatchTab, Platform, SchedulerState, WatchSession } from "@lurkloot/shared/models";
import { isFarmingActive } from "@lurkloot/shared/settings";
import { registerManagedPageContextTabs, setTwitchIntegrity } from "../core/tabs";
import { ALARM_NAME, KICK_ALARM_NAME, PLATFORMS, TWITCH_ALARM_NAME, WATCH_ALARM_NAME } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import { farmingLifecycleEvents } from "./helpers";
import type { BackgroundControllerDeps, ControllerCalls } from "./types";

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
  deps: BackgroundControllerDeps<S>,
  { integritySlice, signalSlice, discoverySlice, tickSlice, settingsSlice, lifecycleSlice }: Pick<ControllerSlices<S>,
    | "integritySlice"
    | "signalSlice"
    | "discoverySlice"
    | "tickSlice"
    | "settingsSlice"
    | "lifecycleSlice"
  >,
  calls: Pick<ControllerCalls<S>,
    | "abortActiveTicks"
    | "abortClaimHandoffs"
    | "abortClaimOnlyOperations"
    | "cancelHeartbeatPublicationLeases"
    | "clearHeartbeatOwnership"
    | "clearHeartbeatOwnershipInBackground"
    | "clearManualWatchClaimAlarmsBestEffort"
    | "clearTwitchChannelPointsAlarmBestEffort"
    | "clearTwitchIntegrityAlarmBestEffort"
    | "closeTwitchIntegrityLifecycle"
    | "createAdapters"
    | "invalidateDiscoverySignalAdmission"
    | "invalidateSelection"
    | "normalizeStartupSettings"
    | "persistAndReport"
    | "reconcileManualWatchClaimAlarms"
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
  | "ensureSchedulerAlarms"
  | "ensureInstalledAt"
  | "handleStartup"
  | "snapshot"
  | "shutdown"
  | "prepareForHostReset"
> {
  const {
    abortActiveTicks,
    abortClaimHandoffs,
    abortClaimOnlyOperations,
    cancelHeartbeatPublicationLeases,
    clearHeartbeatOwnership,
    clearHeartbeatOwnershipInBackground,
    clearManualWatchClaimAlarmsBestEffort,
    clearTwitchChannelPointsAlarmBestEffort,
    clearTwitchIntegrityAlarmBestEffort,
    closeTwitchIntegrityLifecycle,
    createAdapters,
    invalidateDiscoverySignalAdmission,
    invalidateSelection,
    normalizeStartupSettings,
    persistAndReport,
    reconcileManualWatchClaimAlarms,
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
    const settings = await deps.loadSettings();
    await ensureSchedulerAlarms(settings.pollIntervalMinutes);
    await deps.createAlarm(WATCH_ALARM_NAME, { periodInMinutes: 1 });
    await reconcileTwitchChannelPointsAlarm(settings);
    await reconcileManualWatchClaimAlarms(settings);
    if (settings.autoStartDropFarming && isFarmingActive(settings)) {
      await tick(undefined, "install");
    } else {
      await refreshAuthHealth(PLATFORMS, settings);
    }
  }

  async function ensureSchedulerAlarms(periodInMinutes: number): Promise<void> {
    await deps.clearAlarm?.(ALARM_NAME);
    await Promise.all([
      deps.createAlarm(TWITCH_ALARM_NAME, { periodInMinutes }),
      deps.createAlarm(KICK_ALARM_NAME, { periodInMinutes }),
    ]);
  }

  async function ensureInstalledAt(installedAt = new Date().toISOString()): Promise<void> {
    await withStateLock(async () => {
      const state = await deps.loadState();
      if (state.installedAt) return;
      await saveOperationalState({ ...state, installedAt });
    });
  }

  async function handleStartup(): Promise<void> {
    // A restart kills the watchers a handoff would transmit through, so leave
    // no loop running against them.
    abortClaimHandoffs();
    const settings = await deps.loadSettings();
    await ensureSchedulerAlarms(settings.pollIntervalMinutes);
    await deps.createAlarm(WATCH_ALARM_NAME, { periodInMinutes: 1 });
    await reconcileTwitchChannelPointsAlarm(settings);
    await reconcileManualWatchClaimAlarms(settings);
    // A restart kills any in-memory watchers; atomically release their lane
    // ownership before host cleanup, then let tick() rebuild fresh instances.
    await clearHeartbeatOwnership(PLATFORMS);

    const preservePageContexts = isFarmingActive(settings) && settings.autoStartDropFarming;
    const { state, cleanup } = await withStateLock(async () => {
      const state = await deps.loadState();
      registerManagedPageContextTabs(preservePageContexts ? state.managedPageContextTabs ?? {} : {});
      const cleanup = staleStartupCleanup(state, preservePageContexts);
      if (cleanup.hasStaleSession) {
        const restartEvents = farmingLifecycleEvents(state, cleanup.state);
        await persistAndReport(cleanup.state, restartEvents);
      }
      return { state, cleanup };
    });
    if (!cleanup.hasStaleSession) {
      const nextSettings = await normalizeStartupSettings();
      if (nextSettings.autoStartDropFarming && isFarmingActive(nextSettings)) {
        await tick(undefined, "startup");
      } else {
        await refreshAuthHealth(PLATFORMS, nextSettings, true);
      }
      return;
    }

    if (deps.closeManagedTabs && cleanup.managedTabs.length > 0) {
      await deps.closeManagedTabs(cleanup.managedTabs);
    }
    if (!preservePageContexts && deps.stopPageContextTabs && Object.keys(state.managedPageContextTabs ?? {}).length > 0) {
      await withEventCollector(async (emit, events) => {
        await deps.stopPageContextTabs!(state.managedPageContextTabs ?? {}, {
          platforms: ["twitch", "kick"],
          reason: "runtime_restart",
          emit,
        });
        await reportBestEffort(events);
      });
    }

    const nextSettings = await normalizeStartupSettings();

    if (isFarmingActive(nextSettings) && nextSettings.autoStartDropFarming) {
      await tick(undefined, "startup");
    } else {
      await refreshAuthHealth(PLATFORMS, nextSettings, true);
    }
  }

  async function snapshot(): Promise<RuntimeSnapshot<S>> {
    return {
      settings: await deps.loadSettings(),
      state: await deps.loadState(),
    };
  }

  function shutdown(): void {
    lifecycleSlice.controllerShutdown = true;
    for (const platform of PLATFORMS) {
      discoverySlice.discoveryLanes[platform].stop();
      invalidateSelection(platform);
    }
    signalSlice.discoverySignalLifecycleOpen = false;
    for (const platform of PLATFORMS) invalidateDiscoverySignalAdmission(platform);
    settingsSlice.twitchSettingsTransitionGeneration += 1;
    abortActiveTicks("Controller shutdown");
    closeTwitchIntegrityLifecycle("Controller shutdown");
    abortClaimOnlyOperations("Controller shutdown");
    void clearTwitchIntegrityAlarmBestEffort();
    void clearTwitchChannelPointsAlarmBestEffort();
    void clearManualWatchClaimAlarmsBestEffort();
    abortClaimHandoffs();
    void cancelHeartbeatPublicationLeases(PLATFORMS);
    clearHeartbeatOwnershipInBackground(PLATFORMS);
    stopDiscoverySignalControllersInBackground(PLATFORMS);
    stopTwitchChannelPointsPushInBackground();
  }

  async function prepareForHostReset(resetHostStorage?: () => Promise<void>): Promise<void> {
    tickSlice.tickAdmissionSuspended = true;
    signalSlice.discoverySignalLifecycleOpen = false;
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
      await stopDiscoverySignalControllersAndReport(PLATFORMS);
      await stopTwitchChannelPointsPushAndReport();
      await clearTwitchIntegrityAlarmBestEffort();
      await clearTwitchChannelPointsAlarmBestEffort();
      await clearManualWatchClaimAlarmsBestEffort();
      abortClaimHandoffs();
      await clearHeartbeatOwnership(PLATFORMS);
      await withSettingsLock(() => withStateLock(() => withEventCollector(async (emit, events) => {
        const [settings, state] = await Promise.all([deps.loadSettings(), deps.loadState()]);
        const adapters = createAdapters(settings, emit);
        const managedTabs = Object.values(state.managedWatchTabs ?? {}).filter((tab): tab is ManagedWatchTab => tab?.ownedByExtension === true);
        if (deps.closeManagedTabs && managedTabs.length > 0) await deps.closeManagedTabs(managedTabs);
        for (const platform of PLATFORMS) {
          await deps.applyAdFocus?.(platform, state.sessions[platform].tabId, false, emit);
          await adapters[platform].stopWatchTab?.(state.sessions[platform], { closeManagedTabs: true });
        }
        if (deps.stopPageContextTabs) {
          await deps.stopPageContextTabs(state.managedPageContextTabs ?? {}, {
            platforms: PLATFORMS,
            reason: "automation_disabled",
            emit,
          });
        }
        registerManagedPageContextTabs({});
        integritySlice.installedTwitchIntegrity = undefined;
        integritySlice.persistedIntegrityToken = undefined;
        integritySlice.twitchIntegrityRefreshDue = undefined;
        setTwitchIntegrity(undefined);
        await resetHostStorage?.();
        settingsSlice.lastPersistedTwitchEnabled = undefined;
        await reportBestEffort(events);
      })));
    } finally {
      if (!lifecycleSlice.controllerShutdown) {
        signalSlice.discoverySignalLifecycleOpen = true;
        tickSlice.tickAdmissionSuspended = false;
      }
    }
  }

  return {
    ensureAlarm,
    ensureSchedulerAlarms,
    ensureInstalledAt,
    handleStartup,
    snapshot,
    shutdown,
    prepareForHostReset,
  };
}
