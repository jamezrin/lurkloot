import {
  CLI_CAPABILITIES,
  createBackgroundController,
  KICK_ALARM_NAME,
  TWITCH_ALARM_NAME,
  WATCH_ALARM_NAME,
  type CredentialAvailability,
  type TickTrigger,
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

function disabledPlatformsNeedingCleanup(
  state: SchedulerState,
  settings: ReturnType<typeof toEngineSettings>,
): Platform[] {
  return (["twitch", "kick"] as const).filter((platform) => {
    if (settings.platform[platform].enabled) return false;
    const session = state.sessions[platform];
    return state.campaigns[platform].length > 0
      || session.channel !== undefined
      || session.campaignId !== undefined
      || session.rewardId !== undefined
      || session.watchMode !== undefined
      || state.managedWatchTabs?.[platform] !== undefined;
  });
}

interface CliTickDriver {
  tickAndHandOff(platforms?: Platform[], trigger?: TickTrigger): Promise<SchedulerState | undefined>;
}

interface CliTickOptions {
  controller: CliTickDriver;
  enabledPlatforms: Platform[];
  engineSettings: ReturnType<typeof toEngineSettings>;
  loadState(): Promise<SchedulerState>;
  seenSubscriptionWaits: Set<string>;
  logger: Logger;
}

// Each stable driver options object owns one observer per admitted tick result.
// Repeated intervals still request the coalesced follow-up, but do not attach
// another reporting/fallback-state continuation to its shared promise.
const cliTickResults = new WeakMap<CliTickOptions, WeakMap<Promise<SchedulerState | undefined>, Promise<void>>>();

export function runCliTickOnce(options: CliTickOptions): Promise<void> {
  let result: Promise<SchedulerState | undefined>;
  try {
    result = options.controller.tickAndHandOff(options.enabledPlatforms, "alarm");
  } catch (error) {
    options.logger.error(error instanceof Error ? error.message : String(error), "tick");
    return Promise.resolve();
  }
  let pending = cliTickResults.get(options);
  if (!pending) {
    pending = new WeakMap();
    cliTickResults.set(options, pending);
  }
  const existing = pending.get(result);
  if (existing) return existing;
  const run = completeCliTickOnce(options, result);
  pending.set(result, run);
  return run;
}

async function completeCliTickOnce(options: CliTickOptions, result: Promise<SchedulerState | undefined>): Promise<void> {
  const { controller, engineSettings, loadState, seenSubscriptionWaits, logger } = options;
  try {
    let state = await result ?? await loadState();
    const staleDisabledPlatforms = disabledPlatformsNeedingCleanup(state, engineSettings);
    if (staleDisabledPlatforms.length > 0) {
      state = await controller.tickAndHandOff(staleDisabledPlatforms) ?? await loadState();
    }
    const waits = subscriptionWaitKeys([...state.campaigns.twitch, ...state.campaigns.kick]);
    for (const key of seenSubscriptionWaits) {
      if (!waits.has(key)) seenSubscriptionWaits.delete(key);
    }
    for (const [key, message] of waits) {
      if (seenSubscriptionWaits.has(key)) continue;
      seenSubscriptionWaits.add(key);
      logger.info(message, key.slice(0, key.indexOf(":")) as Platform);
    }
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error), "tick");
  }
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
  const enabledPlatforms = (["twitch", "kick"] as const).filter((platform) =>
    engineSettings.platform[platform].enabled);
  const seenSubscriptionWaits = new Set<string>();
  const loadRuntimeState = options.stateStore?.load
    ?? (async (): Promise<SchedulerState> => loadState(statePath));
  const saveRuntimeState = options.stateStore?.save
    ?? (async (state: SchedulerState): Promise<void> => saveState(statePath, state));

  // Timers fire into the controller once it exists.
  let dispatchJob: (name: string) => void = () => undefined;
  const jobs = createNodeJobScheduler((name) => dispatchJob(name));
  const controller = createBackgroundController({
    // No browser tabs, integrity capture or supplemental sources, and no
    // one-minute channel-points job (#590).
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
    kick: {},
  });

  const tickOptions: CliTickOptions = {
    controller, enabledPlatforms, engineSettings,
    loadState: loadRuntimeState, seenSubscriptionWaits, logger,
  };
  const platformTickOptions = enabledPlatforms.length > 0
    ? enabledPlatforms.map((platform) => ({ ...tickOptions, enabledPlatforms: [platform] }))
    : [tickOptions];
  const optionsForTickJob = (platform: Platform): CliTickOptions | undefined => {
    const index = enabledPlatforms.indexOf(platform);
    if (index !== -1) return platformTickOptions[index];
    // With no platform enabled the CLI still runs one cleanup pass per poll
    // interval, as it always has; it rides the Twitch tick job.
    return enabledPlatforms.length === 0 && platform === "twitch" ? tickOptions : undefined;
  };
  const requestTicks = () => {
    // Admission is per platform all the way through the host driver: a fast
    // Kick interval must not accumulate observers waiting for a slow Twitch.
    for (const options of platformTickOptions) void runCliTickOnce(options);
  };

  const runJob = async (name: string) => {
    try {
      await controller.runJob(name);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error), name === WATCH_ALARM_NAME ? "heartbeat" : "job");
    }
  };
  // The engine's jobs, fired by the Node scheduler. Tick jobs go through the
  // CLI's own tick driver, which adds its cleanup and subscription reporting.
  dispatchJob = (name) => {
    const platform = name === TWITCH_ALARM_NAME ? "twitch" : name === KICK_ALARM_NAME ? "kick" : undefined;
    if (platform) {
      const tickOptionsForJob = optionsForTickJob(platform);
      if (tickOptionsForJob) void runCliTickOnce(tickOptionsForJob);
      return;
    }
    void runJob(name);
  };

  logger.info("Starting farming loop", "run");
  if (options.once) {
    jobs.dispose();
    await runCliTickOnce(tickOptions);
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
      void runJob(WATCH_ALARM_NAME);
      requestTicks();
    })();
  });
}
