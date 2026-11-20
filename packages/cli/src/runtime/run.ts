import type { DiagnosticSecrets } from "@lurkloot/shared/diagnostics";
import { createDiagnosticsHistory } from "./diagnostics";
import type { CoreRuntimeMessage, RuntimeMessage } from "@lurkloot/shared/messages";
import { createCliTwitchExtensionLane } from "./twitchExtensions";
import {
  CLI_CAPABILITIES,
  createBackgroundController,
  KICK_ALARM_NAME,
  TWITCH_ALARM_NAME,
  WATCH_ALARM_NAME,
  type CredentialAvailability,
} from "@lurkloot/core/controller";
import type { EngineSettings, Platform, SchedulerState } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { loadState, saveState } from "../storage";
import { toEngineSettings, type CliSettings } from "../settings";
import type { TransportHandle } from "../transport";
import type { Logger } from "../logger";
import { reportCliEvents } from "../events";
import { subscriptionWaitKeys } from "./status";
import { createNodeJobScheduler } from "./jobs";
import { errorMessage } from "@lurkloot/shared/errors";

// The controller the loop builds, as handed to a host started beside it.
type EngineController = ReturnType<typeof createBackgroundController<EngineSettings>>;
type ExtensionToggle = Extract<RuntimeMessage, { type: "setTwitchExtensionEnabled" }>;
export type FarmingController = Omit<EngineController, "handleMessage"> & {
  handleMessage(message: CoreRuntimeMessage | ExtensionToggle): Promise<unknown>;
};

// Something long-lived that runs beside the farming loop, such as the `serve`
// control plane. The loop starts it before the first tick and closes it first
// on shutdown, before the controller and transport go.
export interface FarmingHost {
  close(): Promise<void>;
  // Called once the loop has taken the host and yielded to pending I/O, if
  // shutdown has not begun. `serve --ready-json` prints its ready line here.
  ready?(): void;
}

// Where the controller reads and writes the engine settings. The default reads
// the config file's settings once, drops every save and applies no patch, so
// settings messages fail: what `run` has always done. `serve` passes the
// config-file store (settingsStore.ts, #1000), which validates a patch against
// the CLI schema, keeps the headless invariants and saves to config.json.
export interface SettingsStore {
  load(): Promise<EngineSettings>;
  save(settings: EngineSettings): Promise<void>;
  applyPatch?(current: EngineSettings, patch: SettingsPatch): EngineSettings;
}

export interface RunOptions {
  settings: CliSettings;
  statePath: string;
  transport: TransportHandle;
  logger: Logger;
  // Run a single tick and return (used by smoke checks); otherwise loop until a
  // termination signal.
  once?: boolean;
  // Reports whether a platform has a credential available before each live probe,
  // so the shared engine can distinguish missing_credentials from a rejected or
  // transiently unavailable one. Stays independent of any browser cookie
  // observation — it reads only the CLI's file/env credential store.
  checkCredentialAvailability?: (platform: Platform) => Promise<CredentialAvailability>;
  stateStore?: {
    load(): Promise<SchedulerState>;
    save(state: SchedulerState): Promise<void>;
  };
  settingsStore?: SettingsStore;
  // Started once the controller exists, before startup reconciliation and the
  // first ticks. `run` passes none, so it starts no server. Ignored with `once`.
  startHost?: (
    controller: FarmingController,
    diagnostics: Pick<Awaited<ReturnType<typeof createDiagnosticsHistory>>, "recent">,
  ) => Promise<FarmingHost>;
  diagnosticSecrets?: () => DiagnosticSecrets;
  // Aborting it stops the loop through the same shutdown as SIGINT/SIGTERM.
  // `serve --exit-with-stdin` aborts it when stdin ends. Ignored with `once`.
  stopSignal?: AbortSignal;
}

const nextTurn = () => new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

// Logs each campaign reward newly waiting on a subscription once, and forgets
// the ones that stopped waiting, so a reward that waits again is logged again.
export function createSubscriptionWaitReporter(logger: Logger): (state: SchedulerState) => void {
  const seen = new Set<string>();
  return (state) => {
    const waits = subscriptionWaitKeys([...state.campaigns.twitch, ...state.campaigns.kick]);
    for (const key of seen) {
      if (!waits.has(key)) seen.delete(key);
    }
    for (const [key, message] of waits) {
      if (seen.has(key)) continue;
      seen.add(key);
      logger.info(message, key.slice(0, key.indexOf(":")) as Platform);
    }
  };
}

// Headless farming loop. Reuses the engine's background controller — the same
// tick (discovery → watch decisions → claims → state persistence) the extension
// runs — backed by file storage and Node timers instead of the extension's
// alarms (runtime/jobs.ts). Persists state.json every tick and shuts down cleanly on
// SIGINT/SIGTERM, disposing the transport.
export async function runLoop(options: RunOptions): Promise<void> {
  const { settings, statePath, transport, logger } = options;
  let diagnostics: Awaited<ReturnType<typeof createDiagnosticsHistory>> | undefined;
  const restoreDiagnostics = async () => {
    diagnostics = await createDiagnosticsHistory(statePath, logger, options.diagnosticSecrets);
    return diagnostics;
  };
  // The shared engine works on the EngineSettings contract; expand the CLI's
  // schema once, pinning the headless invariants (always running, always tabless).
  const engineSettings = toEngineSettings(settings);
  const loadRuntimeState =
    options.stateStore?.load ?? (async (): Promise<SchedulerState> => loadState(statePath));
  const settingsStore: SettingsStore = options.settingsStore ?? {
    load: async () => engineSettings,
    // Settings come from the config file; the run loop never mutates them.
    save: async () => {},
  };
  const writeRuntimeState =
    options.stateStore?.save
    ?? (async (state: SchedulerState): Promise<void> => saveState(statePath, state));
  // State writes in flight. Shutdown waits for them before the transport goes
  // and the loop resolves, so the process never exits halfway through one.
  const stateWrites = new Set<Promise<void>>();
  const saveRuntimeState = (state: SchedulerState): Promise<void> => {
    const write = writeRuntimeState(state);
    const forget = () => {
      stateWrites.delete(write);
    };
    // The controller gets the write itself, and with it any failure.
    write.then(forget, forget);
    stateWrites.add(write);
    return write;
  };
  // A write can start while an earlier one is awaited (an aborted tick commits).
  const settleStateWrites = async () => {
    while (stateWrites.size > 0) await Promise.allSettled([...stateWrites]);
  };

  // Timers fire into the controller once it exists.
  let dispatchJob: (name: string) => void = () => undefined;
  const jobs = createNodeJobScheduler((name) => dispatchJob(name));
  const controller = createBackgroundController({
    // No browser tabs or integrity capture.
    capabilities: CLI_CAPABILITIES,
    storage: {
      loadSettings: () => settingsStore.load(),
      saveSettings: (next) => settingsStore.save(next),
      ...(settingsStore.applyPatch
        ? { applySettingsPatch: settingsStore.applyPatch.bind(settingsStore) }
        : {}),
      loadState: loadRuntimeState,
      saveState: saveRuntimeState,
    },
    events: {
      report: (events) => {
        diagnostics?.append(events);
        return reportCliEvents(events, logger);
      },
      notify: async ({ title, message }) => logger.info(`${title}: ${message}`, "notify"),
    },
    jobs,
    adapters: {
      createAdapter: (platform, emit, currentSettings) =>
        transport.createAdapter(platform, emit, currentSettings),
      createAdapters: (emit, currentSettings) => transport.createAdapters(emit, currentSettings),
    },
    ...(options.checkCredentialAvailability
      ? { credentials: { checkAvailability: options.checkCredentialAvailability } }
      : {}),
    twitch: {
      supplementalSources: {
        select: (state, settings, signal, source) =>
          extensionLane.select(state, settings, signal, source),
      },
    },
  });

  const extensionLane = createCliTwitchExtensionLane({
    statePath,
    transport,
    loadSettings: () => settingsStore.load(),
    loadState: loadRuntimeState,
    savePatch: async (settingsPatch) => {
      await controller.handleMessage({ type: "saveSettings", settingsPatch });
    },
    publish: (events) => {
      void controller.reportEvents(events);
    },
    requestTick: () => {
      void controller.tick(["twitch"], "tabless_fallback").catch(() => undefined);
    },
    onSessionReady: () => {
      void controller.reconcileTwitchObservers().catch(() => undefined);
    },
  });
  const stopExtensionCommits = controller.onCommit(extensionLane.onCommit);
  const farmingController: FarmingController = {
    ...controller,
    async handleMessage(message) {
      if (message.type === "setTwitchExtensionEnabled") {
        const result = await extensionLane.setEnabled(message.provider, message.enabled);
        void controller.tick(["twitch"], "manual_tick").catch(() => undefined);
        return result;
      }
      const result = await controller.handleMessage(message);
      if (result && "settings" in result && "state" in result) {
        return {
          ...result,
          state: { ...result.state, twitchExtensions: extensionLane.snapshot() },
        };
      }
      return result;
    },
  };

  let startupReconciliation: Promise<EngineSettings | void> | undefined;
  // Reconciliation can start a save after a stop arrives. Drain it, the
  // controller's shutdown work (including watcher stops), and state saves
  // before disposing the transport.
  const stopFarming = async () => {
    if (startupReconciliation) await startupReconciliation;
    await controller.shutdown();
    stopExtensionCommits();
    await extensionLane.close();
    await controller.settleBackgroundWork();
    await settleStateWrites();
    try {
      await transport.dispose();
    } finally {
      // Disposal can emit transport diagnostics that are still being reported.
      await controller.settleBackgroundWork().finally(() => diagnostics?.close());
    }
  };

  // The CLI's own view of committed state: subscription waits it has not
  // logged yet. The engine decides everything else.
  const reportSubscriptionWaits = createSubscriptionWaitReporter(logger);
  controller.onCommit((change) => {
    if (change.kind === "state") reportSubscriptionWaits(change.state);
  });

  const runJob = async (name: string) => {
    try {
      await controller.runJob(name);
    } catch (error) {
      const scope =
        name === WATCH_ALARM_NAME
          ? "heartbeat"
          : name === TWITCH_ALARM_NAME || name === KICK_ALARM_NAME
            ? "tick"
            : "job";
      logger.error(errorMessage(error), scope);
    }
  };
  // The engine's jobs, fired by the Node scheduler: the same jobs the
  // extension's alarms fire, tick jobs included (#591).
  dispatchJob = (name) => {
    void runJob(name);
  };

  logger.info("Starting farming loop", "run");
  if (options.once) {
    jobs.dispose();
    try {
      await restoreDiagnostics();
      await Promise.all([runJob(TWITCH_ALARM_NAME), runJob(KICK_ALARM_NAME)]);
      await controller.settleBackgroundWork();
      // A tick that changed nothing commits nothing, so report stored waits too.
      try {
        reportSubscriptionWaits(await loadRuntimeState());
      } catch (error) {
        logger.error(errorMessage(error), "run");
      }
    } finally {
      await stopFarming();
    }
    return;
  }

  await new Promise<void>((resolveLoop, rejectLoop) => {
    let stopped = false;
    let host: FarmingHost | undefined;
    // Shutdown joins diagnostics restoration and any host bind in progress.
    let startingHost: Promise<FarmingHost | undefined> | undefined;
    const handleSigint = () => void shutdown("Received SIGINT");
    const handleSigterm = () => void shutdown("Received SIGTERM");
    const stopSignal = options.stopSignal;
    const handleStop = () =>
      void shutdown(typeof stopSignal?.reason === "string" ? stopSignal.reason : "Stop requested");
    const stopJobs = () => {
      jobs.dispose();
      process.removeListener("SIGINT", handleSigint);
      process.removeListener("SIGTERM", handleSigterm);
      stopSignal?.removeEventListener("abort", handleStop);
    };
    const shutdown = async (reason: string) => {
      if (stopped) return;
      stopped = true;
      logger.info(`${reason}; shutting down`, "run");
      stopJobs();
      // The host goes first, so nothing reaches the controller while it stops.
      const current =
        host ?? (startingHost ? await startingHost.catch(() => undefined) : undefined);
      if (current) {
        try {
          await current.close();
        } catch (error) {
          logger.error(errorMessage(error), "run");
        }
      }
      // Before disposing the transport: a post-claim handoff started by the last
      // tick would otherwise keep refreshing against disposed resources, and its
      // pending delay would hold the process open until the handoff's deadline.
      try {
        await stopFarming();
        resolveLoop();
      } catch (error) {
        rejectLoop(error);
      }
    };
    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);
    if (stopSignal?.aborted) {
      handleStop();
      return;
    }
    stopSignal?.addEventListener("abort", handleStop, { once: true });
    void (async () => {
      let started: FarmingHost | undefined;
      try {
        // Record the promise before running host code, with signal handlers
        // already installed while the sidecar loads.
        startingHost = restoreDiagnostics().then((history) => {
          if (!stopped) return options.startHost?.(farmingController, history);
        });
        started = await startingHost;
      } catch (error) {
        if (stopped) return;
        stopped = true;
        stopJobs();
        try {
          await stopFarming();
        } catch (teardownError) {
          logger.error(errorMessage(teardownError), "run");
        }
        rejectLoop(error);
        return;
      }
      // A stop during startup closes the host itself, after waiting for it.
      if (stopped) return;
      if (started) {
        host = started;
        // Give a pending pipe EOF a chance to arrive before announcing ready.
        // Two turns allow a full I/O poll. Later EOF still shuts down normally.
        await nextTurn();
        await nextTurn();
        if (stopped) return;
        started.ready?.();
      }
      // The restart reconciliation the extension runs on browser startup
      // (#593): register the jobs again (Node timers end with the process),
      // release heartbeat ownership held by the previous process, and pause
      // the sessions it left watching. The CLI's own ticks then resume them.
      startupReconciliation = controller.reconcileStartup().catch((error: unknown) => {
        logger.error(errorMessage(error), "run");
      });
      await startupReconciliation;
      startupReconciliation = undefined;
      if (stopped) return;
      // Recovery and shutdown must not wait for initial discovery. A persisted
      // cadence may already be due while the first campaign refresh is slow or
      // blocked, and signal handlers need to be live for that entire interval.
      // Waits already stored are logged once, even when no tick changes them.
      try {
        reportSubscriptionWaits(await loadRuntimeState());
      } catch (error) {
        logger.error(errorMessage(error), "run");
      }
      if (stopped) return;
      void runJob(WATCH_ALARM_NAME);
      void runJob(TWITCH_ALARM_NAME);
      void runJob(KICK_ALARM_NAME);
    })();
  });
}
