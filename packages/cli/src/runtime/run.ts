import { createBackgroundController, type CredentialAvailability } from "@lurkloot/core/controller";
import type { Platform, SchedulerState } from "@lurkloot/shared/models";
import { loadState, saveState } from "../storage";
import { toEngineSettings, type CliSettings } from "../settings";
import type { TransportHandle } from "../transport";
import type { Logger } from "../logger";
import { reportCliEvents } from "../events";
import { subscriptionWaitKeys } from "./status";

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

// Headless farming loop. Reuses the engine's background controller — the same
// tick (discovery → watch decisions → claims → state persistence) the extension
// runs — backed by file storage and a self-driven interval instead of the
// extension's alarms. Persists state.json every tick and shuts down cleanly on
// SIGINT/SIGTERM, disposing the transport.
export async function runLoop(options: RunOptions): Promise<void> {
  const { settings, statePath, transport, logger } = options;
  // The shared engine works on the EngineSettings contract; expand the CLI's
  // schema once, pinning the headless invariants (always running, always tabless).
  const engineSettings = toEngineSettings(settings);
  const enabledPlatforms = (["twitch", "kick"] as const).filter((platform) =>
    engineSettings.platform[platform].enabled);
  const seenSubscriptionWaits = new Set<string>();
  const loadRuntimeState = async (): Promise<SchedulerState> => loadState(statePath);
  const saveRuntimeState = async (state: SchedulerState): Promise<void> => saveState(statePath, state);

  const controller = createBackgroundController({
    loadSettings: async () => engineSettings,
    // Settings come from the config file; the run loop never mutates them.
    saveSettings: async () => {},
    loadState: loadRuntimeState,
    saveState: saveRuntimeState,
    reportEvents: (events) => reportCliEvents(events, logger),
    // The CLI drives its own interval below, so alarm scheduling is a no-op.
    createAlarm: async () => {},
    createAdapter: (platform, emit, currentSettings) => transport.createAdapter(platform, emit, currentSettings),
    createAdapters: (emit, currentSettings) => transport.createAdapters(emit, currentSettings),
    createNotification: async ({ title, message }) => logger.info(`${title}: ${message}`, "notify"),
    ...(options.checkCredentialAvailability ? { checkCredentialAvailability: options.checkCredentialAvailability } : {}),
  });

  const tickOnce = async () => {
    try {
      await controller.tickAndHandOff(enabledPlatforms);
      let state = await loadRuntimeState();
      const staleDisabledPlatforms = disabledPlatformsNeedingCleanup(state, engineSettings);
      if (staleDisabledPlatforms.length > 0) {
        await controller.tickAndHandOff(staleDisabledPlatforms);
        state = await loadRuntimeState();
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
  };

  logger.info("Starting farming loop", "run");
  await tickOnce();

  if (options.once) {
    await transport.dispose();
    return;
  }

  const periodMs = Math.max(1, settings.pollIntervalMinutes) * 60_000;
  await new Promise<void>((resolveLoop) => {
    let stopped = false;
    const timer = setInterval(() => void tickOnce(), periodMs);
    const shutdown = async (signal: string) => {
      if (stopped) return;
      stopped = true;
      logger.info(`Received ${signal}; shutting down`, "run");
      clearInterval(timer);
      // Before disposing the transport: a post-claim handoff started by the last
      // tick would otherwise keep refreshing against disposed resources, and its
      // pending delay would hold the process open until the handoff's deadline.
      controller.shutdown();
      await transport.dispose();
      resolveLoop();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
}
