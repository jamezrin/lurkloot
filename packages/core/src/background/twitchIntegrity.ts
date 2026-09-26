import type { EngineSettings } from "@lurkloot/shared/models";
import type { DiagnosticEvent, EventEmitter } from "@lurkloot/shared/events";
import { isValidTwitchIntegrity, noteTwitchGqlRequest, setTwitchIntegrity, syncManagedTabBreakers } from "../core/tabs";
import { recordManagedTabOpen } from "../core/criticalHealth";
import { integrityFromHeaders } from "../core/twitchIntegrity";
import type { IntegrityHeader, TwitchIntegrity } from "../core/twitchIntegrity";
import {
  TWITCH_INTEGRITY_ALARM_NAME,
  TWITCH_INTEGRITY_REFRESH_JITTER_MAX_MS,
  TWITCH_INTEGRITY_REFRESH_LEAD_MS,
} from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import { correlateTickDiagnostics } from "./helpers";
import type { BackgroundControllerDeps, ControllerCalls, TickDiagnosticContext } from "./types";

// The Twitch integrity token: loading, capture, refresh scheduling and lifecycle.
export function createTwitchIntegrity<S extends EngineSettings>(
  deps: BackgroundControllerDeps<S>,
  { integritySlice, settingsSlice, lifecycleSlice }: Pick<ControllerSlices<S>, "integritySlice" | "settingsSlice" | "lifecycleSlice">,
  calls: Pick<ControllerCalls<S>,
    | "persistAndReport"
    | "reportBestEffort"
    | "withEventCollector"
    | "withSettingsLock"
    | "withStateLock"
  >,
): Pick<ControllerCalls<S>,
  | "clearTwitchIntegrityAlarmBestEffort"
  | "loadStoredTwitchIntegrity"
  | "runTwitchIntegrityRefresh"
  | "captureTwitchIntegrity"
  | "restoreTwitchIntegritySchedule"
  | "prepareTwitchIntegrity"
  | "closeTwitchIntegrityLifecycle"
  | "reconcileTwitchIntegrityLifecycle"
> {
  const { persistAndReport, reportBestEffort, withEventCollector, withSettingsLock, withStateLock } = lateBound(calls);

  function integrityRefreshJitter(token: string): number {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % (TWITCH_INTEGRITY_REFRESH_JITTER_MAX_MS + 1);
  }

  function twitchIntegrityRefreshTarget(integrity: TwitchIntegrity): number {
    return integrity.expiresAt
      - TWITCH_INTEGRITY_REFRESH_LEAD_MS
      - integrityRefreshJitter(integrity.integrity);
  }

  function installTwitchIntegrity(
    integrity: TwitchIntegrity,
    isNew = false,
    emit?: EventEmitter,
    sourceTabId?: number,
  ): void {
    integritySlice.installedTwitchIntegrity = integrity;
    setTwitchIntegrity(integrity, { isNew, sourceTabId }, emit);
  }

  function currentInstalledTwitchIntegrity(): TwitchIntegrity | undefined {
    return isValidTwitchIntegrity(integritySlice.installedTwitchIntegrity)
      ? integritySlice.installedTwitchIntegrity
      : undefined;
  }

  function reconcileStoredTwitchIntegrity(stored: TwitchIntegrity | undefined): TwitchIntegrity | undefined {
    const current = currentInstalledTwitchIntegrity();
    if (!isValidTwitchIntegrity(stored)) return current;
    const storedSupersedesCurrent = !current
      || (
        stored.integrity !== current.integrity
        && integritySlice.persistedIntegrityToken === current.integrity
      );
    integritySlice.persistedIntegrityToken = stored.integrity;
    if (storedSupersedesCurrent) {
      installTwitchIntegrity(stored);
      return stored;
    }
    return current;
  }

  function markTwitchIntegrityRefreshDue(integrity?: TwitchIntegrity): void {
    integritySlice.twitchIntegrityRefreshDue = {
      ...(integrity ? { rejectedToken: integrity.integrity } : {}),
    };
  }

  function withTwitchIntegrityAlarmLock<T>(operation: () => Promise<T>): Promise<T> {
    // Awaited, and released through its own promise rather than a .then() on
    // the result, so an async stack trace taken inside `operation` still
    // reaches the caller (the test lock tracker reads it).
    const previous = integritySlice.twitchIntegrityAlarmMutation;
    let release!: () => void;
    integritySlice.twitchIntegrityAlarmMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (async () => {
      try {
        await previous;
        return await operation();
      } finally {
        release();
      }
    })();
  }

  async function clearTwitchIntegrityAlarm(): Promise<void> {
    await withTwitchIntegrityAlarmLock(async () => {
      await deps.clearAlarm?.(TWITCH_INTEGRITY_ALARM_NAME);
    });
  }

  async function clearTwitchIntegrityAlarmBestEffort(emit?: EventEmitter): Promise<void> {
    try {
      await clearTwitchIntegrityAlarm();
    } catch {
      const event: DiagnosticEvent = {
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "Could not clear the Twitch integrity refresh alarm",
      };
      if (emit) {
        emit(event);
      } else {
        await reportBestEffort([event]);
      }
    }
  }

  async function scheduleTwitchIntegrityRefresh(
    integrity: TwitchIntegrity,
    emit?: EventEmitter,
  ): Promise<void> {
    const when = twitchIntegrityRefreshTarget(integrity);
    if (when <= Date.now()) {
      markTwitchIntegrityRefreshDue(integrity);
      await clearTwitchIntegrityAlarm();
      return;
    }
    const scheduled = await withTwitchIntegrityAlarmLock(async () => {
      let existing: { scheduledTime: number } | undefined;
      try {
        existing = await deps.getAlarm?.(TWITCH_INTEGRITY_ALARM_NAME);
      } catch {
        existing = undefined;
      }
      if (existing && Math.abs(existing.scheduledTime - when) <= 1_000) {
        integritySlice.twitchIntegrityRefreshDue = undefined;
        return false;
      }
      await deps.createAlarm(TWITCH_INTEGRITY_ALARM_NAME, { when });
      return true;
    });
    if (!scheduled) return;
    integritySlice.twitchIntegrityRefreshDue = undefined;
    emit?.({
      category: "diagnostic",
      platform: "twitch",
      level: "debug",
      message: `Scheduled proactive Twitch integrity refresh for ${new Date(when).toISOString()}`,
    });
  }

  async function scheduleTwitchIntegrityRefreshBestEffort(
    integrity: TwitchIntegrity,
    emit?: EventEmitter,
  ): Promise<void> {
    try {
      await scheduleTwitchIntegrityRefresh(integrity, emit);
    } catch (error) {
      const event: DiagnosticEvent = {
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: `Could not schedule Twitch integrity refresh (${error instanceof Error ? error.message : String(error)})`,
      };
      if (emit) {
        emit(event);
      } else {
        await reportBestEffort([event]);
      }
    }
  }

  async function loadStoredTwitchIntegrity(
    lifecycleGeneration: number,
    settingsTransitionGeneration: number,
  ): Promise<void> {
    let twitchEnabled: boolean | undefined;
    let settingsReadError: unknown;
    await withSettingsLock(async () => {
      try {
        twitchEnabled = (await deps.loadSettings()).platform.twitch.enabled;
      } catch (error) {
        settingsReadError = error;
      }
    });
    await withStateLock(() => withEventCollector(async (emit, events) => {
      const ownsStartupLoad = (): boolean =>
        !lifecycleSlice.controllerShutdown
        && integritySlice.integrityLifecycleGeneration === lifecycleGeneration
        && settingsSlice.twitchSettingsTransitionGeneration === settingsTransitionGeneration;
      let integrity: TwitchIntegrity | undefined;
      if (settingsReadError) {
        emit({
          category: "diagnostic",
          level: "debug",
          platform: "twitch",
          message: `Could not read Twitch settings while priming integrity (${settingsReadError instanceof Error ? settingsReadError.message : String(settingsReadError)})`,
        });
      }
      try {
        integrity = await deps.loadTwitchIntegrity?.();
      } catch (error) {
        // A missing/corrupt stored token is non-fatal: fresh page traffic will
        // re-capture one, and claims simply stay best-effort until then.
        emit({
          category: "diagnostic",
          level: "debug",
          platform: "twitch",
          message: `No stored Twitch integrity token to prime (${error instanceof Error ? error.message : String(error)})`,
        });
      }
      if (!ownsStartupLoad()) return;
      if (isValidTwitchIntegrity(integrity)) {
        const current = reconcileStoredTwitchIntegrity(integrity);
        if (twitchEnabled === true && integritySlice.integrityLifecycleOpen) {
          await scheduleTwitchIntegrityRefreshBestEffort(current!, emit);
        }
      } else if (integrity) {
        emit({
          category: "diagnostic",
          level: "debug",
          platform: "twitch",
          message: "Stored Twitch integrity token is expired or too close to expiry; ignoring it",
        });
      }
      await reportBestEffort(events);
    }));
  }

  async function runTwitchIntegrityRefresh(): Promise<void> {
    if (!integritySlice.integrityLifecycleOpen || integritySlice.integrityRefreshAbort) return;
    const abort = new AbortController();
    integritySlice.integrityRefreshAbort = abort;
    const lifecycleGeneration = integritySlice.integrityLifecycleGeneration;
    const ownsRefresh = (): boolean =>
      integritySlice.integrityRefreshAbort === abort
      && !abort.signal.aborted
      && integritySlice.integrityLifecycleGeneration === lifecycleGeneration
      && integritySlice.integrityLifecycleOpen;

    try {
      await integritySlice.initialTwitchIntegrityLoad;
      if (!ownsRefresh()) return;
      await withEventCollector(async (emit, events) => {
        let integrity: TwitchIntegrity | undefined;
        let shouldAcquire = false;
        try {
          await withSettingsLock(async () => {
            if (!ownsRefresh()) return;
            const settings = await deps.loadSettings();
            if (!ownsRefresh()) return;
            if (!settings.platform.twitch.enabled) {
              closeTwitchIntegrityLifecycle("Twitch disabled");
              await clearTwitchIntegrityAlarmBestEffort(emit);
              return;
            }

            await withStateLock(async () => {
              if (!ownsRefresh()) return;
              let stored: TwitchIntegrity | undefined;
              try {
                stored = await deps.loadTwitchIntegrity?.();
              } catch {
                emit({
                  category: "diagnostic",
                  platform: "twitch",
                  level: "debug",
                  message: "Could not reload stored Twitch integrity before proactive refresh",
                });
              }
              if (!ownsRefresh()) return;

              integrity = reconcileStoredTwitchIntegrity(stored);
              if (integrity && twitchIntegrityRefreshTarget(integrity) > Date.now()) {
                await scheduleTwitchIntegrityRefreshBestEffort(integrity, emit);
                return;
              }
              markTwitchIntegrityRefreshDue(integrity);
              shouldAcquire = true;
            });
          });

          if (!shouldAcquire || !deps.ensureTwitchIntegrity || !ownsRefresh()) return;
          const remainingMs = integrity
            ? Math.max(0, integrity.expiresAt - Date.now())
            : 0;
          emit({
            category: "diagnostic",
            platform: "twitch",
            level: "debug",
            message: integrity
              ? `Starting proactive Twitch integrity refresh with ${remainingMs}ms remaining`
              : "Starting proactive Twitch integrity refresh with no valid token available",
          });
          const ready = await deps.ensureTwitchIntegrity(emit, {
            forceRefresh: true,
            reason: "proactive_refresh",
            ...(integrity ? { rejectedToken: integrity.integrity } : {}),
            onManagedPageContextOpen: () =>
              recordTwitchIntegrityManagedTabOpen("proactive_integrity_refresh"),
            signal: abort.signal,
          });
          if (!ready && !abort.signal.aborted) {
            emit({
              category: "diagnostic",
              platform: "twitch",
              level: "debug",
              message: "Proactive Twitch integrity refresh was deferred; the next normal scheduler alarm will retry",
            });
          }
        } catch {
          if (abort.signal.aborted) {
            emit({
              category: "diagnostic",
              platform: "twitch",
              level: "debug",
              message: "Proactive Twitch integrity refresh was cancelled because Twitch stopped",
            });
          } else {
            emit({
              category: "diagnostic",
              platform: "twitch",
              level: "debug",
              message: "Proactive Twitch integrity refresh was deferred; the next normal scheduler alarm will retry",
            });
          }
        } finally {
          await reportBestEffort(events);
        }
      });
    } finally {
      if (integritySlice.integrityRefreshAbort === abort) {
        integritySlice.integrityRefreshAbort = undefined;
      }
    }
  }

  // Fed by the background's webRequest listener with the outgoing headers of
  // gql.twitch.tv requests. Only genuine page-minted requests carry a
  // Client-Integrity header, so integrityFromHeaders returns undefined (and we
  // ignore) our own background fetch and anonymous queries.
  // `tabId` is optional so hosts that cannot attribute a request to a tab still
  // capture tokens; when present it also lets a managed refresh distinguish its
  // own replacement from a concurrent user-tab replay.
  async function captureTwitchIntegrity(headers: IntegrityHeader[] | undefined, tabId?: number): Promise<void> {
    // Noted before the integrity filter: an anonymous GQL request carries no
    // Client-Integrity header but still proves the SPA has booted.
    noteTwitchGqlRequest(tabId);
    const integrity = integrityFromHeaders(headers);
    if (!integrity) return;
    // Installed outside withStateLock, and synchronously before the first await.
    //
    // A mint waits on setTwitchIntegrity waking its waiters (see core/tabs.ts),
    // and the two paths that can force a refresh — runTick around
    // runSchedulerTick, and runPlatformWatchHeartbeat around watcher.tick — both
    // hold the platform lock across that wait. Installing under the same lock
    // made the waiter depend on a lock its own holder owns: the token arrived,
    // sat queued behind the tick, and the wait could only ever time out. Each
    // timeout then booted another page-context tab, which is what users saw as
    // twitch.tv/drops/inventory opening and closing every tick.
    //
    // The compare and the install must stay in one uninterrupted synchronous
    // block: webRequest fires on every GQL request, so an await between them
    // would let two captures interleave and both report themselves as new.
    let isNew = false;
    await withEventCollector(async (emit, events) => {
      isNew = integrity.integrity !== integritySlice.installedTwitchIntegrity?.integrity;
      const sourceTabId = tabId != null && tabId >= 0 ? tabId : undefined;
      installTwitchIntegrity(integrity, isNew, emit, sourceTabId);
      await reportBestEffort(events);
    });
    // Persistence still takes the lock: persistedIntegrityToken is read and
    // written by reconcileStoredTwitchIntegrity under it. Scoped to twitch —
    // this touches no Kick state, and holding both locks let a busy Kick tick
    // delay Twitch token bookkeeping. Nothing waits on this, so queueing behind
    // an in-flight tick is harmless.
    await withStateLock(() => withEventCollector(async (emit, events) => {
      if (integrity.integrity === integritySlice.persistedIntegrityToken || !deps.saveTwitchIntegrity) return;
      try {
        await deps.saveTwitchIntegrity(integrity);
        integritySlice.persistedIntegrityToken = integrity.integrity;
      } catch {
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: "Could not persist the captured Twitch integrity token",
        });
      }
      await reportBestEffort(events);
    }), ["twitch"]);
    if (!isNew) return;
    const lifecycleGeneration = integritySlice.integrityLifecycleGeneration;
    const settingsTransitionGeneration = settingsSlice.twitchSettingsTransitionGeneration;
    const ownsScheduling = (): boolean =>
      !lifecycleSlice.controllerShutdown
      && integritySlice.integrityLifecycleOpen
      && integritySlice.integrityLifecycleGeneration === lifecycleGeneration
      && settingsSlice.twitchSettingsTransitionGeneration === settingsTransitionGeneration;
    await withSettingsLock(() => withEventCollector(async (emit, events) => {
      try {
        if (!ownsScheduling()) return;
        const settings = await deps.loadSettings();
        if (!ownsScheduling() || !settings.platform.twitch.enabled) return;
        await scheduleTwitchIntegrityRefreshBestEffort(integrity, emit);
      } catch (error) {
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: `Could not check Twitch settings before scheduling integrity refresh (${error instanceof Error ? error.message : String(error)})`,
        });
      }
      await reportBestEffort(events);
    }));
  }

  async function recordTwitchIntegrityManagedTabOpen(
    reason: "integrity_readiness" | "proactive_integrity_refresh",
    tickContext?: TickDiagnosticContext,
  ): Promise<void> {
    try {
      await withStateLock(() => withEventCollector(async (emit, events) => {
        if (!integritySlice.integrityLifecycleOpen) return;
        const settings = await deps.loadSettings();
        if (!integritySlice.integrityLifecycleOpen || !settings.criticalFailurePromptEnabled) return;
        const state = await deps.loadState();
        const transition = recordManagedTabOpen(state, "twitch", Date.now(), {
          source: "page_context",
          reason,
        });
        if (transition.event) emit(transition.event);
        syncManagedTabBreakers(transition.state, ["twitch"]);
        await persistAndReport(
          transition.state,
          tickContext ? correlateTickDiagnostics(events, tickContext) : events,
        );
      }));
    } catch {
      await reportBestEffort([{
        category: "diagnostic",
        platform: "twitch",
        level: "warn",
        message: "Could not account for a managed Twitch integrity page context",
        ...tickContext,
      }]);
    }
  }

  async function restoreTwitchIntegritySchedule(
    transitionIsCurrent: () => boolean,
  ): Promise<void> {
    await withStateLock(() => withEventCollector(async (emit, events) => {
      if (!integritySlice.integrityLifecycleOpen || !transitionIsCurrent()) return;
      let stored: TwitchIntegrity | undefined;
      try {
        stored = await deps.loadTwitchIntegrity?.();
      } catch {
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "debug",
          message: "Could not reload stored Twitch integrity after Twitch was enabled",
        });
      }
      if (!integritySlice.integrityLifecycleOpen || !transitionIsCurrent()) return;
      const integrity = reconcileStoredTwitchIntegrity(stored);
      if (integrity && transitionIsCurrent()) {
        await scheduleTwitchIntegrityRefreshBestEffort(integrity, emit);
      }
      await reportBestEffort(events);
    }));
  }

  async function prepareTwitchIntegrity(
    settings: S,
    signal: AbortSignal,
    tickContext: TickDiagnosticContext,
  ): Promise<boolean> {
    const ensureTwitchIntegrity = deps.ensureTwitchIntegrity;
    if (!settings.platform.twitch.enabled || !ensureTwitchIntegrity) return true;
    return withEventCollector(async (emit, events) => {
      const lifecycleGeneration = integritySlice.integrityLifecycleGeneration;
      const due = integritySlice.twitchIntegrityRefreshDue;
      try {
        const ready = await ensureTwitchIntegrity(emit, {
          signal,
          reason: due ? "proactive_refresh" : "readiness",
          onManagedPageContextOpen: () => recordTwitchIntegrityManagedTabOpen(
            due ? "proactive_integrity_refresh" : "integrity_readiness",
            tickContext,
          ),
          ...(due
            ? {
                forceRefresh: true,
                ...(due.rejectedToken ? { rejectedToken: due.rejectedToken } : {}),
              }
            : {}),
        });
        if (!ready) {
          emit({
            category: "diagnostic",
            platform: "twitch",
            level: "warn",
            message: "No valid Twitch integrity token; delaying authenticated Twitch work until the next normal scheduler alarm",
          });
        }
        return ready;
      } catch {
        signal.throwIfAborted();
        const currentSettings = await deps.loadSettings();
        if (
          lifecycleGeneration !== integritySlice.integrityLifecycleGeneration
          || !integritySlice.integrityLifecycleOpen
          || !currentSettings.platform.twitch.enabled
        ) {
          emit({
            category: "diagnostic",
            platform: "twitch",
            level: "debug",
            message: "Twitch integrity acquisition was cancelled because Twitch stopped; continuing other platform work",
          });
          return false;
        }
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: "No valid Twitch integrity token; delaying authenticated Twitch work until the next normal scheduler alarm",
        });
        return false;
      } finally {
        await reportBestEffort(correlateTickDiagnostics(events, tickContext));
      }
    });
  }

  function closeTwitchIntegrityLifecycle(reason: string): void {
    const error = new Error(reason);
    if (integritySlice.integrityLifecycleOpen) {
      integritySlice.integrityLifecycleOpen = false;
      integritySlice.integrityLifecycleGeneration += 1;
    }
    integritySlice.integrityRefreshAbort?.abort(error);
    deps.cancelTwitchIntegrityAcquisition?.(error);
  }

  function reopenTwitchIntegrityLifecycle(): void {
    if (lifecycleSlice.controllerShutdown || integritySlice.integrityLifecycleOpen) return;
    integritySlice.integrityLifecycleOpen = true;
    integritySlice.integrityLifecycleGeneration += 1;
  }

  function reconcileTwitchIntegrityLifecycle(enabled: boolean | undefined): void {
    if (enabled === true) reopenTwitchIntegrityLifecycle();
    else if (enabled === false) closeTwitchIntegrityLifecycle("Twitch disabled");
  }

  return {
    clearTwitchIntegrityAlarmBestEffort,
    loadStoredTwitchIntegrity,
    runTwitchIntegrityRefresh,
    captureTwitchIntegrity,
    restoreTwitchIntegritySchedule,
    prepareTwitchIntegrity,
    closeTwitchIntegrityLifecycle,
    reconcileTwitchIntegrityLifecycle,
  };
}
