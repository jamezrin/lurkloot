import type { Platform, WatchSourceId } from "./models";

// This registry describes supported sources, independently of provider enablement,
// permissions or host capabilities. Missing sources append in this default order.
export const DEFAULT_WATCH_SOURCE_PRIORITY: Record<Platform, readonly WatchSourceId[]> = {
  twitch: ["drops", "nopixel", "fortnite", "watch_streaks", "watchlist"],
  kick: ["drops", "watchlist"],
};

// A missing source that goes in front of another instead of at the end. Watch
// streaks (#897) used to be the head of the Idle Watchlist, so an order saved
// before it existed keeps them just ahead of the watchlist.
const INSERT_MISSING_BEFORE: Partial<Record<WatchSourceId, WatchSourceId>> = {
  watch_streaks: "watchlist",
};

// The watchlist source's id before schema 10. Migration rewrites stored orders;
// reading it here too keeps an unmigrated order's place for the watchlist.
const LEGACY_WATCHLIST_SOURCE_ID = "idle_watchlist";

export function normalizeWatchSourcePriority(platform: Platform, value: unknown): WatchSourceId[] {
  const supported = DEFAULT_WATCH_SOURCE_PRIORITY[platform];
  const result: WatchSourceId[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const source = entry === LEGACY_WATCHLIST_SOURCE_ID ? "watchlist" : entry;
      if (supported.includes(source) && !result.includes(source)) result.push(source);
    }
  }
  for (const source of supported) {
    if (result.includes(source)) continue;
    const anchor = INSERT_MISSING_BEFORE[source];
    const index = anchor ? result.indexOf(anchor) : -1;
    if (index === -1) result.push(source);
    else result.splice(index, 0, source);
  }
  return result;
}

// A present priority wins even when malformed: it normalizes to the defaults,
// rather than reviving an obsolete preference the user already replaced.
export function normalizePlatformWatchSourcePriority(
  platform: Platform,
  settings: unknown,
  legacyFallbackOnly: unknown,
): WatchSourceId[] {
  const block =
    settings !== null && typeof settings === "object"
      ? (settings as Record<string, unknown>)
      : undefined;
  const priority =
    block && Object.hasOwn(block, "watchSourcePriority")
      ? block.watchSourcePriority
      : legacyFallbackOnly === false
        ? ["watchlist"]
        : undefined;
  return normalizeWatchSourcePriority(platform, priority);
}
