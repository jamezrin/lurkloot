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
