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
export type FarmingController = ReturnType<typeof createBackgroundController<EngineSettings>>;

// Something long-lived that runs beside the farming loop, such as the `serve`
// control plane. The loop starts it before the first tick and closes it first
// on shutdown, before the controller and transport go.
export interface FarmingHost {
  close(): Promise<void>;
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
  startHost?: (controller: FarmingController) => Promise<FarmingHost>;
  // Aborting it stops the loop through the same shutdown as SIGINT/SIGTERM.
  // `serve --exit-with-stdin` aborts it when stdin ends. Ignored with `once`.
  stopSignal?: AbortSignal;
}

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
  const saveRuntimeState =
    options.stateStore?.save
    ?? (async (state: SchedulerState): Promise<void> => saveState(statePath, state));

  // Timers fire into the controller once it exists.
  let dispatchJob: (name: string) => void = () => undefined;
  const jobs = createNodeJobScheduler((name) => dispatchJob(name));
  const controller = createBackgroundController({
    // No browser tabs, integrity capture or supplemental sources.
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
      report: (events) => reportCliEvents(events, logger),
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
    twitch: {},
  });

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
    await Promise.all([runJob(TWITCH_ALARM_NAME), runJob(KICK_ALARM_NAME)]);
    await controller.settleBackgroundWork();
    // A tick that changed nothing commits nothing, so report stored waits too.
    try {
      reportSubscriptionWaits(await loadRuntimeState());
    } catch (error) {
      logger.error(errorMessage(error), "run");
    }
    // The tick may have started tabless watchers, and a Kick one holds its own
    // WebSocket and handshake timer outside the transport. Shutdown stops them
    // in the background; drain that before the transport goes, or the process
    // keeps watching after the single tick.
    controller.shutdown();
    await controller.settleBackgroundWork();
    await transport.dispose();
    return;
  }

  await new Promise<void>((resolveLoop, rejectLoop) => {
    let stopped = false;
    let host: FarmingHost | undefined;
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
      if (host) {
        try {
          await host.close();
        } catch (error) {
          logger.error(errorMessage(error), "run");
        }
      }
      // Before disposing the transport: a post-claim handoff started by the last
      // tick would otherwise keep refreshing against disposed resources, and its
      // pending delay would hold the process open until the handoff's deadline.
      try {
        controller.shutdown();
        await transport.dispose();
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
      if (options.startHost) {
        let started: FarmingHost;
        try {
          started = await options.startHost(controller);
        } catch (error) {
          // A host that cannot start (a port in use) stops the loop the way a
          // signal does, or the Node timers would keep the process alive.
          if (stopped) return;
          stopped = true;
          stopJobs();
          try {
            controller.shutdown();
            await transport.dispose();
          } catch (teardownError) {
            logger.error(errorMessage(teardownError), "run");
          }
          rejectLoop(error);
          return;
        }
        // A signal during startup already tore the rest down.
        if (stopped) {
          await started.close().catch((error) => logger.error(errorMessage(error), "run"));
          return;
        }
        host = started;
      }
      // The restart reconciliation the extension runs on browser startup
      // (#593): register the jobs again (Node timers end with the process),
      // release heartbeat ownership held by the previous process, and pause
      // the sessions it left watching. The CLI's own ticks then resume them.
      try {
        await controller.reconcileStartup();
      } catch (error) {
        logger.error(errorMessage(error), "run");
      }
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
      void runJob(WATCH_ALARM_NAME);
      void runJob(TWITCH_ALARM_NAME);
      void runJob(KICK_ALARM_NAME);
    })();
  });
}
