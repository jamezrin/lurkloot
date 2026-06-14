import type { Platform } from "@lurkloot/shared/models";
import type { LogLevel } from "@lurkloot/shared/logging";

// Several modules that emit activity-log entries are pure and have no access to
// the scheduler state (tabs.ts, the platform adapters, the tabless watchers).
// They report through this single sink instead. The background registers an
// implementation that buffers entries into the saved state (see
// createBackgroundController), so the buffered entries flush through `persist`,
// which applies the verbose-logging gate. Defaults to a no-op so tests and the
// page context stay unaffected when no sink is registered.
export type ActivityLogger = (level: LogLevel, message: string, platform?: Platform) => void;

let activityLogger: ActivityLogger | undefined;

export function setActivityLogger(logger: ActivityLogger | undefined): void {
  activityLogger = logger;
}

export function logActivity(level: LogLevel, message: string, platform?: Platform): void {
  activityLogger?.(level, message, platform);
}
