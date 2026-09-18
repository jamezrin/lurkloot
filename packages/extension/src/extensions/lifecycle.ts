// Privileged provider resources belong to one selected channel. Stop is
// synchronous so permission revocation and logout abort in-flight work before
// any asynchronous settings reconciliation begins. Drivers must bind every
// request/socket/timer to the supplied signal and return idempotent cleanup.
export function createTwitchExtensionLifecycle(
  start: (channelId: string, signal: AbortSignal) => Promise<void | (() => void)>,
) {
  type Outcome = "active" | "cancelled" | "failed";
  let current: {
    channelId: string;
    abort: AbortController;
    cleanup?: () => void;
    pending?: Promise<Outcome>;
  } | undefined;

  function dispose(entry: NonNullable<typeof current>) {
    entry.abort.abort();
    const cleanup = entry.cleanup;
    entry.cleanup = undefined;
    try { cleanup?.(); } catch { /* Never expose vendor exceptions. */ }
  }
  function stop() {
    const previous = current;
    current = undefined;
    if (previous) dispose(previous);
  }
  function select(channelId: string): Promise<Outcome> {
    if (current?.channelId === channelId) return current.pending!;
    stop();
    const entry: NonNullable<typeof current> = { channelId, abort: new AbortController() };
    current = entry;
    entry.pending = (async (): Promise<Outcome> => {
      try {
        const cleanup = await start(channelId, entry.abort.signal);
        entry.cleanup = cleanup || undefined;
        if (current !== entry || entry.abort.signal.aborted) {
          dispose(entry);
          return "cancelled";
        }
        return "active";
      } catch {
        const cancelled = current !== entry || entry.abort.signal.aborted;
        if (current === entry) current = undefined;
        dispose(entry);
        return cancelled ? "cancelled" : "failed";
      }
    })();
    return entry.pending;
  }
  return { select, stop };
}
