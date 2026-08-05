// Every heartbeat request runs inside runPlatformWatchHeartbeat, which holds the
// platform state lock across watcher.tick(). An unbounded request therefore does
// not merely fail the heartbeat — it head-blocks that platform's lock, and every
// tick, auth refresh and token install queued behind it waits for the network to
// give up on its own.
//
// That is not hypothetical: spade.twitch.tv ships blocked in AdGuard's DNS filter
// and most adblock lists, and a blackholed host stalls on TCP connect rather than
// failing fast. Bounding each request keeps a blocked domain a heartbeat problem
// instead of a whole-platform stall, and makes the cause visible in diagnostics
// rather than surfacing as a generic network error minutes later.
export const HEARTBEAT_REQUEST_TIMEOUT_MS = 15_000;

// Thrown so callers can tell "we gave up waiting" apart from a network error the
// host actually reported. Transports redact request URLs from heartbeat failures,
// so this message deliberately carries no URL and is safe to surface verbatim.
export class HeartbeatTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Twitch heartbeat request timed out after ${timeoutMs}ms`);
    this.name = "HeartbeatTimeoutError";
  }
}

export function isHeartbeatTimeoutError(error: unknown): error is HeartbeatTimeoutError {
  return error instanceof HeartbeatTimeoutError;
}

// Races the operation against the deadline rather than relying on the operation
// honouring the signal: the CLI's impersonate transport hands work to cycleTLS,
// which ignores AbortSignal entirely. A caller signal still wins with its own
// reason, so stopping a platform is not reported as a timeout.
export async function withHeartbeatTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal | null,
  timeoutMs = HEARTBEAT_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new HeartbeatTimeoutError(timeoutMs));
  }, timeoutMs);

  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });

  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
