import { dirname, resolve } from "node:path";
import { ALARM_NAME, createBackgroundController, WATCH_ALARM_NAME } from "@stream-autopilot/core/controller";
import { setTwitchIntegrity } from "@stream-autopilot/core/tabs";
import type { CliConfig } from "../config";
import { applyEnvOverrides, AuthStore } from "../authStore";
import { FileStorage } from "../storage";
import { createHttpAdapters } from "../transport/http";
import { registerConsoleLogger } from "../logger";

// Drives the full farming loop headlessly. Reuses the extension's background
// controller verbatim; the only CLI-specific wiring is file/auth-store-backed
// storage, an interval-based replacement for chrome.alarms, and console output.
export async function runLoop(config: CliConfig): Promise<void> {
  registerConsoleLogger(config.settings.enabledLogLevels);

  if (config.transport !== "http") {
    throw new Error(`The "${config.transport}" transport is not implemented yet; use transport: "http" for now.`);
  }

  const store = new AuthStore(config.authDir);
  const credentials = applyEnvOverrides(await store.loadCredentials());
  const integrity = await store.loadIntegrity();
  if (integrity) setTwitchIntegrity(integrity);

  const stateFile = resolve(dirname(config.path), "state.json");
  const storage = new FileStorage(stateFile, config.settings);

  // chrome.alarms replacement: each createAlarm(name) (re)arms a setInterval that
  // calls the matching controller handler. Re-arming on the same name (e.g. when
  // the poll interval changes) clears the previous timer first.
  const timers = new Map<string, NodeJS.Timeout>();
  // Late-bound: the controller needs createAlarm in its deps, and createAlarm needs
  // the controller to call back into. Wired right after construction.
  let controller: ReturnType<typeof createBackgroundController> | undefined;

  const createAlarm = async (name: string, options: { periodInMinutes: number }): Promise<void> => {
    const existing = timers.get(name);
    if (existing) clearInterval(existing);
    const periodMs = Math.max(1, options.periodInMinutes) * 60_000;
    const handler = () => {
      if (name === ALARM_NAME) void controller?.tick();
      else if (name === WATCH_ALARM_NAME) void controller?.runWatchHeartbeat();
    };
    timers.set(name, setInterval(handler, periodMs));
  };

  controller = createBackgroundController({
    loadSettings: () => storage.loadSettings(),
    saveSettings: (settings) => storage.saveSettings(settings),
    loadState: () => storage.loadState(),
    saveState: (state) => storage.saveState(state),
    createAlarm,
    createNotification: async ({ title, message }) => console.log(`🔔 ${title}: ${message}`),
    loadTwitchIntegrity: () => store.loadIntegrity(),
    saveTwitchIntegrity: (value) => store.saveIntegrity(value),
    createAdapters: () => createHttpAdapters(credentials),
  });

  console.log(`Starting farming loop (transport=http, state=${stateFile})`);
  console.log(`  poll every ${config.settings.pollIntervalMinutes} min; watch heartbeat every 1 min. Ctrl-C to stop.`);

  await controller.ensureAlarm();
  // Run an immediate first discovery tick rather than waiting a full poll interval.
  await controller.tick();

  await new Promise<void>((resolvePromise) => {
    const shutdown = (signal: string) => {
      console.log(`\nReceived ${signal}; stopping…`);
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
      resolvePromise();
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });

  console.log("Stopped. Latest state persisted to disk.");
}
