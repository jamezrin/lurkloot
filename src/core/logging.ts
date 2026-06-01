import type { EventLogEntry, SchedulerState } from "./models";

export type LogLevel = "debug" | "info" | "warn" | "error";

// Ordered low → high so the popup can filter "this level and above" and so debug
// (the noisiest) sits at the bottom.
export const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// The activity log is a rolling buffer. Debug entries fill it faster than the
// old info/warn/error-only stream, so keep a deeper history than before.
export const MAX_LOG_ENTRIES = 250;

export function appendLog(
  state: SchedulerState,
  entry: Omit<EventLogEntry, "id" | "at">,
): SchedulerState {
  const fullEntry: EventLogEntry = {
    ...entry,
    id: `${Date.now()}-${entry.platform ?? "all"}-${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
  };
  return {
    ...state,
    events: [fullEntry, ...state.events].slice(0, MAX_LOG_ENTRIES),
  };
}
