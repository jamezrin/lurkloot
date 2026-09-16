import type { Platform, WatchSourceId } from "./models";

// This registry describes supported sources, independently of provider enablement,
// permissions or host capabilities. Missing sources append in this default order.
export const DEFAULT_WATCH_SOURCE_PRIORITY: Record<Platform, readonly WatchSourceId[]> = {
  twitch: ["drops", "nopixel", "fortnite", "idle_watchlist"],
  kick: ["drops", "idle_watchlist"],
};

export function normalizeWatchSourcePriority(platform: Platform, value: unknown): WatchSourceId[] {
  const supported = DEFAULT_WATCH_SOURCE_PRIORITY[platform];
  const result: WatchSourceId[] = [];
  if (Array.isArray(value)) {
    for (const source of value) {
      if (supported.includes(source) && !result.includes(source)) result.push(source);
    }
  }
  for (const source of supported) {
    if (!result.includes(source)) result.push(source);
  }
  return result;
}

// A present priority wins even when malformed: it normalizes to the defaults,
// rather than reviving an obsolete preference the user already replaced.
export function normalizePlatformWatchSourcePriority(platform: Platform, settings: unknown, legacyFallbackOnly: unknown): WatchSourceId[] {
  const block = settings !== null && typeof settings === "object" ? settings as Record<string, unknown> : undefined;
  const priority = block && Object.hasOwn(block, "watchSourcePriority")
    ? block.watchSourcePriority
    : legacyFallbackOnly === false ? ["idle_watchlist"] : undefined;
  return normalizeWatchSourcePriority(platform, priority);
}
