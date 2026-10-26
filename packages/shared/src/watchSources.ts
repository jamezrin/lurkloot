import type { Platform, WatchSourceId } from "./models";

// This registry describes supported sources, independently of provider enablement,
// permissions or host capabilities. Missing sources append in this default order.
export const DEFAULT_WATCH_SOURCE_PRIORITY: Record<Platform, readonly WatchSourceId[]> = {
  twitch: ["watch_streaks", "drops", "nopixel", "fortnite", "watchlist"],
  kick: ["drops", "watchlist"],
};

// A missing source that goes first instead of at the end. Watch streaks (#897)
// lead the default order, so an order saved before they existed gets them first
// too. Streaks are opt-in per row, so this only matters once one is turned on.
const INSERT_MISSING_FIRST: ReadonlySet<WatchSourceId> = new Set(["watch_streaks"]);

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
    if (INSERT_MISSING_FIRST.has(source)) result.unshift(source);
    else result.push(source);
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
