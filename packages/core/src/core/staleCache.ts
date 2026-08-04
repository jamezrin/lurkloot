// A single-value cache that never makes a caller wait on a refresh once
// something has been cached before: get() returns the last known value
// (possibly stale) immediately, and refreshOnce() kicks off (or joins) a
// background update instead of blocking. Only the very first refresh, before
// anything has ever been cached, is meant to be awaited by the caller — see
// the Twitch/Kick adapters' listFollowedChannels for the intended usage,
// which is also why this exists: both hosts reconstruct the platform adapter
// fresh every scheduler tick, so this cache is held by state injected from
// outside the adapter (TwitchDiscoveryState / KickDiscoveryState) rather than
// by the adapter itself.
export class StaleWhileRevalidateCache<T> {
  private cached?: { value: T; expiresAt: number };
  // Shared across overlapping callers so two refreshes never run at once; also
  // means `perform` must never reject (see refreshOnce), since its rejection
  // would otherwise be handed to an unrelated caller.
  private refreshing?: Promise<void>;

  constructor(private readonly ttlMs: number) {}

  // undefined means "never populated"; the caller distinguishes that (block
  // once) from a stale-but-present value (serve it, refresh in the background).
  get(): T | undefined {
    return this.cached?.value;
  }

  isStale(): boolean {
    return !this.cached || this.cached.expiresAt <= Date.now();
  }

  // Runs `perform` at most once concurrently, sharing the in-flight promise
  // with any overlapping caller. `perform` must resolve rather than reject —
  // swallow its own failures and resolve with whatever value represents "no
  // data" for T (e.g. an empty array) — because a rejection here would
  // propagate to every caller currently sharing this refresh, including ones
  // whose own abort signal was never involved.
  refreshOnce(perform: () => Promise<T>): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = perform()
        .then((value) => {
          this.cached = { value, expiresAt: Date.now() + this.ttlMs };
        })
        .finally(() => {
          this.refreshing = undefined;
        });
    }
    return this.refreshing;
  }
}
