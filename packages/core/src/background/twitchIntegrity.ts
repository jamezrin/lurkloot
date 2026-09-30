import type { EngineSettings } from "@lurkloot/shared/models";
import type { DiagnosticEvent, EventEmitter } from "@lurkloot/shared/events";
import { isValidTwitchIntegrity, noteTwitchGqlRequest, setTwitchIntegrity, syncManagedTabBreakers } from "../core/tabRegistry";
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
import type { BackgroundHostPorts } from "./hostPorts";
import type { BackgroundJob } from "./jobs";
import type { ControllerCalls, TickDiagnosticContext } from "./types";

// The proactive refresh job. A host that cannot capture integrity leaves it inert.
export const TWITCH_INTEGRITY_JOBS: Readonly<Record<string, BackgroundJob>> = {
  [TWITCH_INTEGRITY_ALARM_NAME]: {
    run: (runner) => runner.runTwitchIntegrityRefresh(),
    requires: "twitchIntegrityCapture",
  },
};

// The service's own state (#589). The token itself has one in-memory copy, the
// tab registry's, which outgoing Twitch requests and the host's capture waits
// read; this service is the only writer.
interface TwitchIntegrityState {
  // The service's two lanes (#589), taken in this order and never under a
  // controller lock: token bookkeeping (load, reconcile, persist) and the
  // refresh alarm (every schedule and clear).
  bookkeeping: Promise<unknown>;
  alarmMutation: Promise<unknown>;
  // Bumped by a host reset, so a capture's save cannot write back a token the
  // reset just wiped.
  resetGeneration: number;
  refreshAbort: AbortController | undefined;
  lifecycleGeneration: number;
  lifecycleOpen: boolean;
  // Settings saves in flight that disable Twitch. While one is pending no
  // refresh or schedule is admitted; a save that fails simply ends it, so
  // there is nothing to roll back (#589).
  pendingDisables: number;
  // Serializes the reconciles that follow committed Twitch enable/disable.
  transitionReconcile: Promise<void>;
  transitionGeneration: number;
  persistedToken: string | undefined;
  // A missing rejectedToken means there was no usable bundle when the refresh
  // became due. Keeping the wrapper object distinguishes that from "not due."
  refreshDue: { rejectedToken?: string } | undefined;
  // The startup load of the stored token, started once every module exists.
  initialLoad: Promise<void>;
}

// The Twitch integrity token: loading, capture, refresh scheduling and lifecycle.
export function createTwitchIntegrity<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  { lifecycleSlice, tabRegistry }: Pick<ControllerSlices<S>, "lifecycleSlice" | "tabRegistry">,
  calls: Pick<ControllerCalls<S>,
    | "persistAndReport"
    | "reportBestEffort"
    | "withEventCollector"
    | "withStateLock"
    | "currentTwitchSettingsTransition"
  >,
): Pick<ControllerCalls<S>,
  | "clearTwitchIntegrityAlarmBestEffort"
  | "loadStoredTwitchIntegrity"
  | "runTwitchIntegrityRefresh"
  | "captureTwitchIntegrity"
  | "restoreTwitchIntegritySchedule"
  | "prepareTwitchIntegrity"
  | "closeTwitchIntegrityLifecycle"
  | "holdTwitchIntegrityForDisable"
  | "reconcileTwitchIntegrityAfterCommit"
  | "startInitialTwitchIntegrityLoad"
  | "awaitInitialTwitchIntegrityLoad"
  | "resetTwitchIntegrity"
> {
  const {
    currentTwitchSettingsTransition,
    persistAndReport,
    reportBestEffort,
    withEventCollector,
    withStateLock,
  } = lateBound(calls);
  const integrityPort = ports.twitch.integrity;
  const integritySlice: TwitchIntegrityState = {
    bookkeeping: Promise.resolve(),
    alarmMutation: Promise.resolve(),
    resetGeneration: 0,
    refreshAbort: undefined,
    lifecycleGeneration: 0,
    lifecycleOpen: true,
    pendingDisables: 0,
    transitionReconcile: Promise.resolve(),
    transitionGeneration: 0,
    persistedToken: undefined,
    refreshDue: undefined,
    initialLoad: Promise.resolve(),
  };

  // Whether new integrity work is admitted: the lifecycle is open and no save
  // that disables Twitch is in flight.
  function lifecycleAdmits(): boolean {
    return integritySlice.lifecycleOpen && integritySlice.pendingDisables === 0;
  }

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
    setTwitchIntegrity(tabRegistry, integrity, { isNew, sourceTabId }, emit);
  }

  function currentInstalledTwitchIntegrity(): TwitchIntegrity | undefined {
    return isValidTwitchIntegrity(tabRegistry.twitchIntegrity)
      ? tabRegistry.twitchIntegrity
      : undefined;
  }

  function reconcileStoredTwitchIntegrity(stored: TwitchIntegrity | undefined): TwitchIntegrity | undefined {
    const current = currentInstalledTwitchIntegrity();
    if (!isValidTwitchIntegrity(stored)) return current;
    const storedSupersedesCurrent = !current
      || (
        stored.integrity !== current.integrity
        && integritySlice.persistedToken === current.integrity
      );
    integritySlice.persistedToken = stored.integrity;
    if (storedSupersedesCurrent) {
      installTwitchIntegrity(stored);
      return stored;
    }
    return current;
  }

  function markTwitchIntegrityRefreshDue(integrity?: TwitchIntegrity): void {
    integritySlice.refreshDue = {
      ...(integrity ? { rejectedToken: integrity.integrity } : {}),
    };
  }

  // Runs `operation` after every earlier operation on `lane`.
  function inLane<T>(lane: "bookkeeping" | "alarmMutation", operation: () => Promise<T>): Promise<T> {
    // Awaited, and released through its own promise rather than a .then() on
    // the result, so an async stack trace taken inside `operation` still
    // reaches the caller (the test lock tracker reads it).
    const previous = integritySlice[lane];
    let release!: () => void;
    integritySlice[lane] = new Promise<void>((resolve) => {
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

  function withTwitchIntegrityAlarmLock<T>(operation: () => Promise<T>): Promise<T> {
    return inLane("alarmMutation", operation);
  }

  function withIntegrityBookkeeping<T>(operation: () => Promise<T>): Promise<T> {
    return inLane("bookkeeping", operation);
  }

  async function clearTwitchIntegrityAlarm(): Promise<void> {
    await withTwitchIntegrityAlarmLock(async () => {
      await ports.jobs.cancel(TWITCH_INTEGRITY_ALARM_NAME);
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

  // `owns` is re-checked inside the alarm lane, right before the alarm is set.
  // A disable closes the lifecycle and then clears the alarm through the same
  // lane, so whichever runs last there decides, never a schedule that decided
  // before the disable.
  async function scheduleTwitchIntegrityRefresh(
    integrity: TwitchIntegrity,
    emit?: EventEmitter,
    owns: () => boolean = () => true,
  ): Promise<void> {
    const when = twitchIntegrityRefreshTarget(integrity);
    if (when <= Date.now()) {
      markTwitchIntegrityRefreshDue(integrity);
      await clearTwitchIntegrityAlarm();
      return;
    }
    const scheduled = await withTwitchIntegrityAlarmLock(async () => {
      if (!owns()) return false;
      let existing: { scheduledTime: number } | undefined;
      try {
        existing = await ports.jobs.get(TWITCH_INTEGRITY_ALARM_NAME);
      } catch {
        existing = undefined;
      }
      if (existing && Math.abs(existing.scheduledTime - when) <= 1_000) {
        integritySlice.refreshDue = undefined;
        return false;
      }
      if (!owns()) return false;
      await ports.jobs.ensure(TWITCH_INTEGRITY_ALARM_NAME, { when });
      return true;
    });
    if (!scheduled) return;
    integritySlice.refreshDue = undefined;
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
    owns?: () => boolean,
  ): Promise<void> {
    try {
      await scheduleTwitchIntegrityRefresh(integrity, emit, owns);
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
    try {
      twitchEnabled = (await ports.storage.loadSettings()).platform.twitch.enabled;
    } catch (error) {
      settingsReadError = error;
    }
    await withIntegrityBookkeeping(() => withEventCollector(async (emit, events) => {
      const ownsStartupLoad = (): boolean =>
        !lifecycleSlice.controllerShutdown
        && integritySlice.lifecycleGeneration === lifecycleGeneration
        && currentTwitchSettingsTransition() === settingsTransitionGeneration;
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
        integrity = await ports.twitch.integrity?.load();
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
        const ownsSchedule = (): boolean =>
          twitchEnabled === true && lifecycleAdmits() && ownsStartupLoad();
        if (ownsSchedule()) {
          await scheduleTwitchIntegrityRefreshBestEffort(current!, emit, ownsSchedule);
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
    if (!lifecycleAdmits() || integritySlice.refreshAbort) return;
    const abort = new AbortController();
    integritySlice.refreshAbort = abort;
    const lifecycleGeneration = integritySlice.lifecycleGeneration;
    const ownsRefresh = (): boolean =>
      integritySlice.refreshAbort === abort
      && !abort.signal.aborted
      && integritySlice.lifecycleGeneration === lifecycleGeneration
      && lifecycleAdmits();

    try {
      await integritySlice.initialLoad;
      if (!ownsRefresh()) return;
      await withEventCollector(async (emit, events) => {
        let integrity: TwitchIntegrity | undefined;
        let shouldAcquire = false;
        try {
          await (async () => {
            if (!ownsRefresh()) return;
            const settings = await ports.storage.loadSettings();
            if (!ownsRefresh()) return;
            if (!settings.platform.twitch.enabled) {
              closeTwitchIntegrityLifecycle("Twitch disabled");
              await clearTwitchIntegrityAlarmBestEffort(emit);
              return;
            }

            await withIntegrityBookkeeping(async () => {
              if (!ownsRefresh()) return;
              let stored: TwitchIntegrity | undefined;
              try {
                stored = await ports.twitch.integrity?.load();
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
                await scheduleTwitchIntegrityRefreshBestEffort(integrity, emit, ownsRefresh);
                return;
              }
              markTwitchIntegrityRefreshDue(integrity);
              shouldAcquire = true;
            });
          })();

          if (!shouldAcquire || !integrityPort || !ownsRefresh()) return;
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
          const ready = await integrityPort.ensure(emit, {
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
      if (integritySlice.refreshAbort === abort) {
        integritySlice.refreshAbort = undefined;
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
    noteTwitchGqlRequest(tabRegistry, tabId);
    const integrity = integrityFromHeaders(headers);
    if (!integrity) return;
    // Installed outside every lock, and synchronously before the first await.
    //
    // A mint waits on setTwitchIntegrity waking its waiters (see core/tabRegistry.ts),
    // and the two paths that can force a refresh — runTick around the
    // scheduler tick, and runPlatformWatchHeartbeat around watcher.tick — both
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
      isNew = integrity.integrity !== tabRegistry.twitchIntegrity?.integrity;
      const sourceTabId = tabId != null && tabId >= 0 ? tabId : undefined;
      installTwitchIntegrity(integrity, isNew, emit, sourceTabId);
      await reportBestEffort(events);
    });
    // Persisted on the bookkeeping lane, where reconcileStoredTwitchIntegrity
    // also reads and writes the persisted token. It takes no controller lock
    // (#589), so it never queues behind a tick. A host reset since the capture
    // wins: the token it wiped is not written back.
    const resetGeneration = integritySlice.resetGeneration;
    await withIntegrityBookkeeping(() => withEventCollector(async (emit, events) => {
      if (
        integrity.integrity === integritySlice.persistedToken
        || !integrityPort
        || integritySlice.resetGeneration !== resetGeneration
      ) return;
      try {
        await integrityPort.save(integrity);
        integritySlice.persistedToken = integrity.integrity;
      } catch {
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: "Could not persist the captured Twitch integrity token",
        });
      }
      await reportBestEffort(events);
    }));
    if (!isNew) return;
    const lifecycleGeneration = integritySlice.lifecycleGeneration;
    const settingsTransitionGeneration = currentTwitchSettingsTransition();
    const ownsScheduling = (): boolean =>
      !lifecycleSlice.controllerShutdown
      && lifecycleAdmits()
      && integritySlice.lifecycleGeneration === lifecycleGeneration
      && currentTwitchSettingsTransition() === settingsTransitionGeneration;
    await withEventCollector(async (emit, events) => {
      try {
        if (!ownsScheduling()) return;
        const settings = await ports.storage.loadSettings();
        if (!ownsScheduling() || !settings.platform.twitch.enabled) return;
        await scheduleTwitchIntegrityRefreshBestEffort(integrity, emit, ownsScheduling);
      } catch (error) {
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "warn",
          message: `Could not check Twitch settings before scheduling integrity refresh (${error instanceof Error ? error.message : String(error)})`,
        });
      }
      await reportBestEffort(events);
    });
  }

  async function recordTwitchIntegrityManagedTabOpen(
    reason: "integrity_readiness" | "proactive_integrity_refresh",
    tickContext?: TickDiagnosticContext,
  ): Promise<void> {
    try {
      await withStateLock(() => withEventCollector(async (emit, events) => {
        if (!lifecycleAdmits()) return;
        const settings = await ports.storage.loadSettings();
        if (!lifecycleAdmits() || !settings.criticalFailurePromptEnabled) return;
        const state = await ports.storage.loadState();
        const transition = recordManagedTabOpen(state, "twitch", Date.now(), {
          source: "page_context",
          reason,
        });
        if (transition.event) emit(transition.event);
        syncManagedTabBreakers(tabRegistry, transition.state, ["twitch"]);
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
    const ownsRestore = (): boolean => lifecycleAdmits() && transitionIsCurrent();
    await withIntegrityBookkeeping(() => withEventCollector(async (emit, events) => {
      if (!ownsRestore()) return;
      let stored: TwitchIntegrity | undefined;
      try {
        stored = await ports.twitch.integrity?.load();
      } catch {
        emit({
          category: "diagnostic",
          platform: "twitch",
          level: "debug",
          message: "Could not reload stored Twitch integrity after Twitch was enabled",
        });
      }
      if (!ownsRestore()) return;
      const integrity = reconcileStoredTwitchIntegrity(stored);
      if (integrity && transitionIsCurrent()) {
        await scheduleTwitchIntegrityRefreshBestEffort(integrity, emit, ownsRestore);
      }
      await reportBestEffort(events);
    }));
  }

  async function prepareTwitchIntegrity(
    settings: S,
    signal: AbortSignal,
    tickContext: TickDiagnosticContext,
  ): Promise<boolean> {
    if (!settings.platform.twitch.enabled || !integrityPort) return true;
    const port = integrityPort;
    return withEventCollector(async (emit, events) => {
      const lifecycleGeneration = integritySlice.lifecycleGeneration;
      const due = integritySlice.refreshDue;
      try {
        const ready = await port.ensure(emit, {
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
        const currentSettings = await ports.storage.loadSettings();
        if (
          lifecycleGeneration !== integritySlice.lifecycleGeneration
          || !lifecycleAdmits()
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
    if (integritySlice.lifecycleOpen) {
      integritySlice.lifecycleOpen = false;
      integritySlice.lifecycleGeneration += 1;
    }
    integritySlice.refreshAbort?.abort(error);
    ports.twitch.integrity?.cancelAcquisition(error);
  }

  function reopenTwitchIntegrityLifecycle(): void {
    if (lifecycleSlice.controllerShutdown || integritySlice.lifecycleOpen) return;
    integritySlice.lifecycleOpen = true;
    integritySlice.lifecycleGeneration += 1;
  }

  // A settings save that disables Twitch, from as soon as it is known: it
  // cancels the acquisition and refresh in flight at once, since a mint can
  // run for ~22s, and admits no new integrity work until the hold is
  // released, whether or not the save succeeded. Nothing to roll back.
  function holdTwitchIntegrityForDisable(): () => void {
    const error = new Error("Twitch disabled");
    integritySlice.refreshAbort?.abort(error);
    ports.twitch.integrity?.cancelAcquisition(error);
    integritySlice.pendingDisables += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      integritySlice.pendingDisables -= 1;
    };
  }

  // After a save that changed, or tried to change, Twitch's enabled flag,
  // whatever sent it (#589): the lifecycle and the refresh schedule follow the
  // latest stored settings. Serialized, so saves that finish out of order
  // still converge on the last one.
  function reconcileTwitchIntegrityAfterCommit(): Promise<void> {
    const generation = ++integritySlice.transitionGeneration;
    const isCurrent = (): boolean =>
      !lifecycleSlice.controllerShutdown && integritySlice.transitionGeneration === generation;
    const run = integritySlice.transitionReconcile.then(async () => {
      if (!isCurrent()) return;
      const { enabled } = (await ports.storage.loadSettings()).platform.twitch;
      if (!isCurrent()) return;
      if (!enabled) {
        closeTwitchIntegrityLifecycle("Twitch disabled");
        await clearTwitchIntegrityAlarmBestEffort();
        return;
      }
      reopenTwitchIntegrityLifecycle();
      await restoreTwitchIntegritySchedule(isCurrent);
    });
    integritySlice.transitionReconcile = run.catch(() => undefined);
    return run;
  }

  // Primes the in-memory token from storage whenever the background script
  // (re)evaluates, so a claim right after a service-worker wake can use the
  // last captured token before any fresh page traffic is observed.
  function startInitialTwitchIntegrityLoad(): void {
    integritySlice.initialLoad = loadStoredTwitchIntegrity(
      integritySlice.lifecycleGeneration,
      currentTwitchSettingsTransition(),
    );
  }

  function awaitInitialTwitchIntegrityLoad(): Promise<void> {
    return integritySlice.initialLoad;
  }

  // Host reset: forgets the token, in memory and as
  // persisted, and any refresh that was due.
  function resetTwitchIntegrity(): void {
    integritySlice.resetGeneration += 1;
    integritySlice.persistedToken = undefined;
    integritySlice.refreshDue = undefined;
    setTwitchIntegrity(tabRegistry, undefined);
  }

  return {
    startInitialTwitchIntegrityLoad,
    awaitInitialTwitchIntegrityLoad,
    resetTwitchIntegrity,
    clearTwitchIntegrityAlarmBestEffort,
    loadStoredTwitchIntegrity,
    runTwitchIntegrityRefresh,
    captureTwitchIntegrity,
    restoreTwitchIntegritySchedule,
    prepareTwitchIntegrity,
    closeTwitchIntegrityLifecycle,
    holdTwitchIntegrityForDisable,
    reconcileTwitchIntegrityAfterCommit,
  };
}
