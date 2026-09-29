import type { EngineSettings, ManualWatchState, Platform, SchedulerState } from "@lurkloot/shared/models";
import { isTimestampStale } from "./timestamps";

// How long a manual-watch report counts after it was checked.
export const MANUAL_WATCH_TTL_MS = 20_000;

// The manual-watch query (#596): the platform's manual-watch record while it
// is active and fresh, else undefined. Every owner that pauses for, or claims
// on behalf of, the user's own viewing reads it here rather than re-deriving
// it; only the manual-watch service writes the records.
export function recentManualWatch(
  state: Pick<SchedulerState, "manualWatch">,
  platform: Platform,
  now = Date.now(),
): ManualWatchState | undefined {
  const watch = state.manualWatch?.[platform];
  if (!watch?.active || isTimestampStale(watch.checkedAt, MANUAL_WATCH_TTL_MS, now)) return undefined;
  return watch;
}

export function hasRecentManualWatch(
  state: Pick<SchedulerState, "manualWatch">,
  platform: Platform,
  now = Date.now(),
): boolean {
  return recentManualWatch(state, platform, now) !== undefined;
}

// Whether farming defers to the user's viewing: the setting is on and they are
// watching. Claims on the user's behalf follow the same rule.
export function pausedForManualWatch(
  settings: Pick<EngineSettings, "pauseOnManualWatch">,
  state: Pick<SchedulerState, "manualWatch">,
  platform: Platform,
  now = Date.now(),
): boolean {
  return settings.pauseOnManualWatch && hasRecentManualWatch(state, platform, now);
}
