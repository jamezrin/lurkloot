import { setActivityLogger } from "@stream-autopilot/core/activityLog";
import { shouldRecord, type LogLevel } from "@stream-autopilot/shared/logging";

// Routes the engine's activity-log sink to the console, filtered by the same
// enabledLogLevels the extension uses. The core modules call logActivity(); this
// is where those land in a headless run.
export function registerConsoleLogger(enabledLevels: readonly LogLevel[]): void {
  setActivityLogger((level, message, platform) => {
    if (!shouldRecord(level, enabledLevels)) return;
    const tag = platform ? `[${platform}]` : "";
    const line = `${level.toUpperCase().padEnd(5)} ${tag} ${message}`.trim();
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  });
}
