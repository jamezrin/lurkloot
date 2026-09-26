import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { PlatformAdapter } from "../platforms/adapter";
import type { DiscoverySignalController } from "../core/discoverySignals";
import { PLATFORMS } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import { emitHostCallbackError } from "./helpers";
import type { BackgroundControllerDeps, ControllerCalls, DiscoverySignalRefreshRequest } from "./types";

// Discovery-signal controllers and the refreshes they request.
export function createDiscoverySignals<S extends EngineSettings>(
  deps: BackgroundControllerDeps<S>,
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

  function drainDiscoverySignalEvents(
    controller: DiscoverySignalController,
    emit: EventEmitter,
  ): void {
    for (const event of controller.drainEvents()) emit(event);
  }

  async function stopDiscoverySignalController(
    platform: Platform,
    emit: EventEmitter,
  ): Promise<void> {
    invalidateDiscoverySignalAdmission(platform);
    const controller = signalSlice.discoverySignalControllers.get(platform);
    if (!controller) return;
    // Delete before awaiting host cleanup so a callback captured by an obsolete
    // controller cannot enqueue work while its socket/timer teardown finishes.
    signalSlice.discoverySignalControllers.delete(platform);
    drainDiscoverySignalEvents(controller, emit);
    try {
      await controller.stop();
    } catch (error) {
      emitHostCallbackError(emit, platform, error, "Could not stop the discovery signal observer");
    } finally {
      drainDiscoverySignalEvents(controller, emit);
    }
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

  async function reconcileDiscoverySignalControllers(
    state: SchedulerState,
    settings: EngineSettings,
    adapters: Record<Platform, PlatformAdapter>,
    emit: EventEmitter,
    platforms?: Platform[],
  ): Promise<void> {
    const targets = platforms ?? PLATFORMS;
    for (const platform of targets) {
      const session = state.sessions[platform];
      const adapter = adapters[platform];
      const factory = adapter.createDiscoverySignalController;
      const wanted = signalSlice.discoverySignalLifecycleOpen
        && !signalSlice.discoverySignalPlatformBlocked[platform]
        && settings.platform[platform].enabled
        && state.authHealth[platform].status === "healthy"
        && session.status === "watching"
        && Boolean(session.channel)
        && Boolean(factory);
      const existing = signalSlice.discoverySignalControllers.get(platform);

      if (!wanted || !session.channel || !factory) {
        if (existing) await stopDiscoverySignalController(platform, emit);
        continue;
      }

      let controller = existing;
      if (!controller) {
        try {
          controller = factory();
          invalidateDiscoverySignalAdmission(platform);
          signalSlice.discoverySignalControllers.set(platform, controller);
        } catch (error) {
          emitHostCallbackError(emit, platform, error, "Could not create the discovery signal observer");
          continue;
        }
      }

      drainDiscoverySignalEvents(controller, emit);
      try {
        await controller.start(
          { platform, channel: session.channel },
          () => {
            if (signalSlice.discoverySignalControllers.get(platform) !== controller) return;
            queueDiscoverySignalRefresh(platform, controller);
          },
        );
      } catch (error) {
        emitHostCallbackError(emit, platform, error, "Could not start the discovery signal observer");
      } finally {
        drainDiscoverySignalEvents(controller, emit);
      }

      // Reset/shutdown/disable cleanup can race a host controller whose start()
      // awaits transport setup. Teardown wins, and the just-finished obsolete
      // start must not retain its callback or transport.
      if (
        signalSlice.discoverySignalControllers.get(platform) !== controller
        || !signalSlice.discoverySignalLifecycleOpen
        || lifecycleSlice.controllerShutdown
      ) {
        if (signalSlice.discoverySignalControllers.get(platform) === controller) {
          invalidateDiscoverySignalAdmission(platform);
          signalSlice.discoverySignalControllers.delete(platform);
        }
        try {
          await controller.stop();
        } catch (error) {
          emitHostCallbackError(emit, platform, error, "Could not stop the discovery signal observer");
        } finally {
          drainDiscoverySignalEvents(controller, emit);
        }
      }
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
      && signalSlice.discoverySignalLifecycleOpen
      && !signalSlice.discoverySignalPlatformBlocked[platform]
      && signalSlice.discoverySignalAuthRefreshes[platform] === 0
      && signalSlice.discoverySignalAdmissionGeneration[platform] === request.generation
      && signalSlice.discoverySignalControllers.get(platform) === request.controller;
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
          const settings = await deps.loadSettings();
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
    invalidateDiscoverySignalAdmission,
    discoverySignalRefreshAllowed,
    reserveDiscoverySignalAuthRefresh,
    startPendingDiscoverySignalRefresh,
  };
}
