import type { LogLevel } from "@lurkloot/shared/logging";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Minimal leveled stderr logger. Logs go to stderr so command stdout (e.g. the
// effective config from `validate-config`) stays machine-readable.
export interface Logger {
  level: LogLevel;
  log(level: LogLevel, message: string, scope?: string): void;
  debug(message: string, scope?: string): void;
  info(message: string, scope?: string): void;
  warn(message: string, scope?: string): void;
  error(message: string, scope?: string): void;
}

export function createLogger(level: LogLevel = "info"): Logger {
  const emit = (entryLevel: LogLevel, message: string, scope?: string): void => {
    if (ORDER[entryLevel] < ORDER[level]) return;
    const stamp = new Date().toISOString();
    const where = scope ? ` [${scope}]` : "";
    process.stderr.write(`${stamp} ${entryLevel.toUpperCase()}${where} ${message}\n`);
  };
  return {
    level,
    log: emit,
    debug: (message, scope) => emit("debug", message, scope),
    info: (message, scope) => emit("info", message, scope),
    warn: (message, scope) => emit("warn", message, scope),
    error: (message, scope) => emit("error", message, scope),
  };
}

// Under a launcher (`serve --ready-json` / `--exit-with-stdin`), the parent may
// stop reading this process's output before it closes stdin. The next write
// then fails with EPIPE, emitted as an `error` event that would crash the
// process in the middle of its shutdown. This makes the stream's output best
// effort: a failed write is dropped. The handler logs nothing, since a log line
// written from a stderr error would only fail again.
export function tolerateClosedReader(stream: NodeJS.WritableStream): void {
  stream.on("error", () => {});
}
