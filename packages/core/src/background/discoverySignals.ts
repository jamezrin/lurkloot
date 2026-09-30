import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { PlatformAdapter } from "../platforms/adapter";
import type { DiscoverySignalController } from "../core/discoverySignals";
import { PLATFORMS } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import type { BackgroundHostPorts } from "./hostPorts";
import type { StateTransaction } from "./stateTransaction";
import type { ControllerCalls, DiscoverySignalRefreshRequest } from "./types";

// Discovery-signal controllers and the refreshes they request.
export function createDiscoverySignals<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  transaction: Pick<StateTransaction<S>, "onCommit">,
  { signalSlice, tickSlice, lifecycleSlice }: Pick<ControllerSlices<S>, "signalSlice" | "tickSlice" | "lifecycleSlice">,
  calls: Pick<ControllerCalls<S>,
    | "completeTickAndHandOff"
    | "diagnosticEvent"
    | "reportBestEffort"
    | "requestTickBatch"
    | "retainCurrentTickReasons"
    | "tickTriggerSummary"
    | "withEventCollector"
  >,
): Pick<ControllerCalls<S>,
  | "stopDiscoverySignalController"
  | "stopDiscoverySignalControllers"
  | "stopDiscoverySignalControllersAndReport"
  | "stopDiscoverySignalControllersInBackground"
  | "reconcileDiscoverySignalControllers"
  | "reconcileDiscoverySignalsAfterCommit"
  | "discoverySignalEpochs"
  | "invalidateDiscoverySignalAdmission"
  | "discoverySignalRefreshAllowed"
  | "reserveDiscoverySignalAuthRefresh"
  | "startPendingDiscoverySignalRefresh"
> {
  const {
    completeTickAndHandOff,
    diagnosticEvent,
    reportBestEffort,
    requestTickBatch,
    retainCurrentTickReasons,
    tickTriggerSummary,
    withEventCollector,
  } = lateBound(calls);

  // After a commit that leaves a platform's auth unhealthy (#595), or that
  // ends its watch session (a manual tab close pausing it, #596), its observer
  // stops. The hook acts on the commit it observes even when that has changed
  // since (an account change); an observer restarted in between is started
  // again by the next reconcile. Only the watching-to-not-watching transition
  // counts, so commits made while idle do not keep bumping the slot's epoch.
  transaction.onCommit(async (change) => {
    if (change.kind !== "state") return;
    const { previous, state } = change;
    const platforms = change.platforms.filter((platform) =>
      state.authHealth[platform].status !== "healthy"
      || (previous.sessions[platform].status === "watching" && state.sessions[platform].status !== "watching"));
    if (platforms.length > 0) await stopDiscoverySignalControllersAndReport(platforms);
  });

  function discoverySignalObserver(platform: Platform): DiscoverySignalController | undefined {
    return signalSlice.discoverySignalSlots[platform].current;
  }

  async function stopDiscoverySignalController(
    platform: Platform,
    emit: EventEmitter,
  ): Promise<void> {
    await signalSlice.discoverySignalSlots[platform].stop(emit, {
      onChange: () => invalidateDiscoverySignalAdmission(platform),
    });
  }

  async function stopDiscoverySignalControllers(
    platforms: readonly Platform[],
    emit: EventEmitter,
  ): Promise<void> {
    await Promise.all(platforms.map((platform) =>
      stopDiscoverySignalController(platform, emit)));
  }

  async function stopDiscoverySignalControllersAndReport(
    platforms: readonly Platform[],
  ): Promise<void> {
    await withEventCollector(async (emit, events) => {
      await stopDiscoverySignalControllers(platforms, emit);
      await reportBestEffort(events);
    });
  }

  function stopDiscoverySignalControllersInBackground(
    platforms: readonly Platform[],
  ): void {
    for (const platform of platforms) invalidateDiscoverySignalAdmission(platform);
    const run = stopDiscoverySignalControllersAndReport(platforms).catch((error) => {
      const platform = platforms.length === 1 ? platforms[0] : undefined;
      diagnosticEvent(
        "warn",
        `Discovery signal observer cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        platform,
      );
    });
    tickSlice.backgroundWork = tickSlice.backgroundWork.then(() => run, () => run);
  }

  // Starts or stops each platform's observer for `state`. `since` holds each
  // slot's epoch read before `state` was: a stop in between (an auth
  // transition, a removed tab) means `state` is out of date, so the observer is
  // not created, or is stopped again once its start finishes.
  async function reconcileDiscoverySignalControllers(
    state: SchedulerState,
    settings: EngineSettings,
    adapters: Record<Platform, PlatformAdapter>,
    emit: EventEmitter,
    platforms: readonly Platform[] = PLATFORMS,
    since: Partial<Record<Platform, number>> = {},
  ): Promise<void> {
    for (const platform of platforms) {
      const slot = signalSlice.discoverySignalSlots[platform];
      const session = state.sessions[platform];
      const channel = session.channel;
      await slot.reconcile({
        wanted: !signalSlice.discoverySignalPlatformBlocked[platform]
          && settings.platform[platform].enabled
          && state.authHealth[platform].status === "healthy"
          && session.status === "watching"
          && Boolean(channel),
        factory: adapters[platform].createDiscoverySignalController,
        open: () => lifecycleSlice.observersOpen && !lifecycleSlice.controllerShutdown,
        since: since[platform] ?? slot.epoch,
        emit,
        onChange: () => invalidateDiscoverySignalAdmission(platform),
        start: (controller) => controller.start(
          { platform, channel: channel! },
          () => {
            if (discoverySignalObserver(platform) !== controller) return;
            queueDiscoverySignalRefresh(platform, controller);
          },
        ),
      });
    }
  }

  // Each platform's slot epoch, read where the state the observers follow is
  // committed, under its lock.
  function discoverySignalEpochs(platforms: readonly Platform[]): Partial<Record<Platform, number>> {
    return Object.fromEntries(platforms.map((platform) =>
      [platform, signalSlice.discoverySignalSlots[platform].epoch]));
  }

  // After a tick commits (#587), with no lock held: reconciles against the
  // state the tick committed. A stop since the commit (auth transition, removed
  // tab, disabled platform) bumps the epoch, so the observer backs off.
  async function reconcileDiscoverySignalsAfterCommit(
    committed: SchedulerState,
    since: Partial<Record<Platform, number>>,
    settings: EngineSettings,
    adapters: Record<Platform, PlatformAdapter>,
    emit: EventEmitter,
    platforms: readonly Platform[],
  ): Promise<void> {
    try {
      await reconcileDiscoverySignalControllers(committed, settings, adapters, emit, platforms, since);
    } catch (error) {
      diagnosticEvent(
        "warn",
        `Discovery signal observer reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
        platforms.length === 1 ? platforms[0] : undefined,
      );
    }
  }

  function invalidateDiscoverySignalAdmission(platform: Platform): void {
    signalSlice.discoverySignalRefreshPending[platform] = undefined;
    signalSlice.discoverySignalAdmissionGeneration[platform] += 1;
    const pending = tickSlice.tickAdmission[platform].pending;
    if (pending && !retainCurrentTickReasons(platform, pending)) {
      tickSlice.tickAdmission[platform].pending = undefined;
      pending.resolve([platform, []]);
    }
  }

  function discoverySignalRefreshAllowed(
    platform: Platform,
    request: DiscoverySignalRefreshRequest,
  ): boolean {
    return !lifecycleSlice.controllerShutdown
      && lifecycleSlice.observersOpen
      && !signalSlice.discoverySignalPlatformBlocked[platform]
      && signalSlice.discoverySignalAuthRefreshes[platform] === 0
      && signalSlice.discoverySignalAdmissionGeneration[platform] === request.generation
      && discoverySignalObserver(platform) === request.controller;
  }

  function reserveDiscoverySignalAuthRefresh(platform: Platform): () => void {
    // Credential observation calls invalidate/check without awaiting the pair.
    // Close signal admission synchronously so no callback or paused refresh loop
    // can launch obsolete platform work before the first state-lock await lands.
    invalidateDiscoverySignalAdmission(platform);
    signalSlice.discoverySignalAuthRefreshes[platform] += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      signalSlice.discoverySignalAuthRefreshes[platform] -= 1;
    };
  }

  function queueDiscoverySignalRefresh(
    platform: Platform,
    controller: DiscoverySignalController,
  ): void {
    const request: DiscoverySignalRefreshRequest = {
      controller,
      generation: signalSlice.discoverySignalAdmissionGeneration[platform],
      count: (signalSlice.discoverySignalRefreshPending[platform]?.count ?? 0) + 1,
    };
    if (!discoverySignalRefreshAllowed(platform, request)) return;
    signalSlice.discoverySignalRefreshPending[platform] = request;
    startPendingDiscoverySignalRefresh(platform);
  }

  function startPendingDiscoverySignalRefresh(platform: Platform): void {
    if (signalSlice.discoverySignalRefreshRunning[platform] || tickSlice.tickAdmission[platform].active) return;
    const queued = signalSlice.discoverySignalRefreshPending[platform];
    if (!queued) return;
    if (!discoverySignalRefreshAllowed(platform, queued)) {
      signalSlice.discoverySignalRefreshPending[platform] = undefined;
      return;
    }
    // Reserve synchronously. A burst in the async setup window must see the
    // running loop and collapse into its one pending request.
    signalSlice.discoverySignalRefreshRunning[platform] = true;

    const run = (async () => {
      try {
        while (signalSlice.discoverySignalRefreshPending[platform]) {
          const current = signalSlice.discoverySignalRefreshPending[platform];
          if (!current) break;
          if (!discoverySignalRefreshAllowed(platform, current)) {
            if (signalSlice.discoverySignalRefreshPending[platform] === current) {
              signalSlice.discoverySignalRefreshPending[platform] = undefined;
            }
            continue;
          }
          signalSlice.discoverySignalRefreshPending[platform] = undefined;
          const settings = await ports.storage.loadSettings();
          if (!discoverySignalRefreshAllowed(platform, current)) continue;
          if (!settings.platform[platform].enabled) {
            signalSlice.discoverySignalRefreshPending[platform] = undefined;
            break;
          }
          diagnosticEvent("debug", `Coalesced scheduler triggers (${tickTriggerSummary({ discovery_signal: current.count })})`, platform);
          const batch = requestTickBatch([platform], "discovery_signal", current);
          await (batch.handoff ??= completeTickAndHandOff(batch));
        }
      } finally {
        signalSlice.discoverySignalRefreshRunning[platform] = false;
        // Covers a signal arriving after the loop's last condition check but
        // before the running reservation is released.
        startPendingDiscoverySignalRefresh(platform);
      }
    })().catch((error) => {
      diagnosticEvent(
        "warn",
        `Discovery signal refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        platform,
      );
    });

    tickSlice.backgroundWork = tickSlice.backgroundWork.then(() => run, () => run);
  }

  return {
    stopDiscoverySignalController,
    stopDiscoverySignalControllers,
    stopDiscoverySignalControllersAndReport,
    stopDiscoverySignalControllersInBackground,
    reconcileDiscoverySignalControllers,
    reconcileDiscoverySignalsAfterCommit,
    discoverySignalEpochs,
    invalidateDiscoverySignalAdmission,
    discoverySignalRefreshAllowed,
    reserveDiscoverySignalAuthRefresh,
    startPendingDiscoverySignalRefresh,
  };
}
