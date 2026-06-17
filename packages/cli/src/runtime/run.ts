import { createBackgroundController } from "@lurkloot/core/controller";
import { setActivityLogger } from "@lurkloot/core/activityLog";
import type { ExtensionSettings, SchedulerState } from "@lurkloot/shared/models";
import { loadState, saveState } from "../storage";
import type { TransportHandle } from "../transport";
import type { Logger } from "../logger";

export interface RunOptions {
  settings: ExtensionSettings;
  statePath: string;
  transport: TransportHandle;
  logger: Logger;
  // Run a single tick and return (used by smoke checks); otherwise loop until a
  // termination signal.
  once?: boolean;
}

// Headless farming loop. Reuses the engine's background controller — the same
// tick (discovery → watch decisions → claims → state persistence) the extension
// runs — backed by file storage and a self-driven interval instead of the
// extension's alarms. Persists state.json every tick and shuts down cleanly on
// SIGINT/SIGTERM, disposing the transport.
export async function runLoop(options: RunOptions): Promise<void> {
  const { settings, statePath, transport, logger } = options;

  const controller = createBackgroundController({
    loadSettings: async () => settings,
    // Settings come from the config file; the run loop never mutates them.
    saveSettings: async () => {},
    loadState: () => loadState(statePath),
    saveState: (state: SchedulerState) => saveState(statePath, state),
    // The CLI drives its own interval below, so alarm scheduling is a no-op.
    createAlarm: async () => {},
    createAdapters: () => transport.adapters,
    createNotification: async ({ title, message }) => logger.info(`${title}: ${message}`, "notify"),
  });

  // Route engine activity-log output to the CLI logger (the controller's own
  // sink records into state events; here console visibility is what matters).
  setActivityLogger((level, message, scope) => logger.log(level, message, scope));

  const tickOnce = async () => {
    try {
      await controller.tick();
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
      await transport.dispose();
      resolveLoop();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
}
