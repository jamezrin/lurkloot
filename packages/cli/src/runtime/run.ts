import { createBackgroundController } from "@lurkloot/core/controller";
import type { SchedulerState } from "@lurkloot/shared/models";
import { loadState, saveState } from "../storage";
import { toEngineSettings, type CliSettings } from "../settings";
import type { TransportHandle } from "../transport";
import type { Logger } from "../logger";
import type { EngineEvent } from "@lurkloot/shared/events";

function formatEvent(event: EngineEvent): string {
  if (event.category === "diagnostic") return event.message;
  const details = Object.entries(event.data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return `${event.code}${details ? ` ${details}` : ""}`;
}

export interface RunOptions {
  settings: CliSettings;
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
  // The shared engine works on the EngineSettings contract; expand the CLI's
  // schema once, pinning the headless invariants (always running, always tabless).
  const engineSettings = toEngineSettings(settings);

  const controller = createBackgroundController({
    loadSettings: async () => engineSettings,
    // Settings come from the config file; the run loop never mutates them.
    saveSettings: async () => {},
    loadState: () => loadState(statePath),
    saveState: (state: SchedulerState) => saveState(statePath, state),
    reportEvents: async (events) => {
      for (const event of events) logger.log(event.level, formatEvent(event), event.platform ?? event.category);
    },
    // The CLI drives its own interval below, so alarm scheduling is a no-op.
    createAlarm: async () => {},
    createAdapters: (emit) => transport.createAdapters(emit),
    createNotification: async ({ title, message }) => logger.info(`${title}: ${message}`, "notify"),
  });

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
