import type { EngineSettings } from "@lurkloot/shared/models";
import { watchPausedBySchedule } from "@lurkloot/shared/watchPauseSchedule";

// The scheduled watch pause query (#1162): whether the daily window applies at
// `now`. Every owner that starts or keeps a watch reads it here. It derives
// from the settings and the clock alone, so nothing persists it: a restart, a
// settings save or a host that slept through a boundary reads the right answer
// on its next check.
export function pausedBySchedule(
  settings: Pick<EngineSettings, "watchPauseSchedule">,
  now = Date.now(),
): boolean {
  return watchPausedBySchedule(settings.watchPauseSchedule, now);
}
