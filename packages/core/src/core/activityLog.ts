import type { Platform } from "@lurkloot/shared/models";
import type { LogLevel } from "@lurkloot/shared/logging";

// Several modules that emit activity-log entries are pure and have no access to
// the scheduler state (tabs.ts, the platform adapters, the tabless watchers).
// They report through this temporary single sink instead. The controller binds
// it only while a serialized operation collector is active, then restores the
// previous host logger. Task 4 replaces this bridge with scoped dependencies.
// Defaults to a no-op so pure tests and page contexts remain unaffected.
export type ActivityLogger = (level: LogLevel, message: string, platform?: Platform) => void;

let activityLogger: ActivityLogger | undefined;

export function setActivityLogger(logger: ActivityLogger | undefined): ActivityLogger | undefined {
  const previous = activityLogger;
  activityLogger = logger;
  return previous;
}

export function logActivity(level: LogLevel, message: string, platform?: Platform): void {
  activityLogger?.(level, message, platform);
}
