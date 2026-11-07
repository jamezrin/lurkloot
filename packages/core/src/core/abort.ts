// Stops a caller waiting on `operation` once `signal` aborts, rejecting with
// the signal's reason. The operation itself keeps running; only the wait ends.
// The one implementation of this race: import it rather than copying it.
export async function withAbortSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
