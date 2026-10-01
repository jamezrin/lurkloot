import {
  CLI_CAPABILITIES,
  createBackgroundController,
  KICK_ALARM_NAME,
  TWITCH_ALARM_NAME,
  WATCH_ALARM_NAME,
  type CredentialAvailability,
} from "@lurkloot/core/controller";
import type { Platform, SchedulerState } from "@lurkloot/shared/models";
import { loadState, saveState } from "../storage";
import { toEngineSettings, type CliSettings } from "../settings";
import type { TransportHandle } from "../transport";
import type { Logger } from "../logger";
import { reportCliEvents } from "../events";
import { subscriptionWaitKeys } from "./status";
import { createNodeJobScheduler } from "./jobs";

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
  const loadRuntimeState = options.stateStore?.load
    ?? (async (): Promise<SchedulerState> => loadState(statePath));
  const saveRuntimeState = options.stateStore?.save
    ?? (async (state: SchedulerState): Promise<void> => saveState(statePath, state));

  // Timers fire into the controller once it exists.
  let dispatchJob: (name: string) => void = () => undefined;
  const jobs = createNodeJobScheduler((name) => dispatchJob(name));
  const controller = createBackgroundController({
    // No browser tabs, integrity capture or supplemental sources.
    capabilities: CLI_CAPABILITIES,
    storage: {
      loadSettings: async () => engineSettings,
      // Settings come from the config file; the run loop never mutates them.
      saveSettings: async () => {},
      loadState: loadRuntimeState,
      saveState: saveRuntimeState,
    },
    events: {
      report: (events) => reportCliEvents(events, logger),
      notify: async ({ title, message }) => logger.info(`${title}: ${message}`, "notify"),
    },
    jobs,
    adapters: {
      createAdapter: (platform, emit, currentSettings) => transport.createAdapter(platform, emit, currentSettings),
      createAdapters: (emit, currentSettings) => transport.createAdapters(emit, currentSettings),
    },
    ...(options.checkCredentialAvailability ? { credentials: { checkAvailability: options.checkCredentialAvailability } } : {}),
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
      const scope = name === WATCH_ALARM_NAME
        ? "heartbeat"
        : name === TWITCH_ALARM_NAME || name === KICK_ALARM_NAME ? "tick" : "job";
      logger.error(error instanceof Error ? error.message : String(error), scope);
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
      logger.error(error instanceof Error ? error.message : String(error), "run");
    }
    await transport.dispose();
    return;
  }

  await new Promise<void>((resolveLoop, rejectLoop) => {
    let stopped = false;
    const handleSigint = () => void shutdown("SIGINT");
    const handleSigterm = () => void shutdown("SIGTERM");
    const shutdown = async (signal: string) => {
      if (stopped) return;
      stopped = true;
      logger.info(`Received ${signal}; shutting down`, "run");
      jobs.dispose();
      process.removeListener("SIGINT", handleSigint);
      process.removeListener("SIGTERM", handleSigterm);
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
    void (async () => {
      // The restart reconciliation the extension runs on browser startup
      // (#593): register the jobs again (Node timers end with the process),
      // release heartbeat ownership held by the previous process, and pause
      // the sessions it left watching. The CLI's own ticks then resume them.
      try {
        await controller.reconcileStartup();
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error), "run");
      }
      if (stopped) return;
      // Recovery and shutdown must not wait for initial discovery. A persisted
      // cadence may already be due while the first campaign refresh is slow or
      // blocked, and signal handlers need to be live for that entire interval.
      // Waits already stored are logged once, even when no tick changes them.
      try {
        reportSubscriptionWaits(await loadRuntimeState());
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error), "run");
      }
      void runJob(WATCH_ALARM_NAME);
      void runJob(TWITCH_ALARM_NAME);
      void runJob(KICK_ALARM_NAME);
    })();
  });
}
