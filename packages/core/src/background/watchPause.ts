import { PLATFORMS, type EngineSettings, type Platform } from "@lurkloot/shared/models";
import { nextWatchPauseBoundary } from "@lurkloot/shared/watchPauseSchedule";
import { pausedBySchedule } from "../core/watchPause";
import { WATCH_PAUSE_ALARM_NAME } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import type { BackgroundHostPorts } from "./hostPorts";
import type { BackgroundJob } from "./jobs";
import type { ControllerCalls } from "./types";

// The watch pause boundary service (#1162). The scheduler decides the pause
// itself, from the settings and the clock, on every tick; this only makes a
// tick happen when a window starts or ends, instead of up to a poll interval
// later. It owns one one-shot job, armed for the next boundary, and keeps no
// state of its own: each run compares what the window says now with what each
// platform's session says, and ticks the platforms that disagree. That makes
// the startup, settings-save and slept-through-a-boundary cases the same check.

// Fired just past the boundary, so the tick lands inside the new state.
const BOUNDARY_SLACK_MS = 1_000;
// Node timers run on a clock that stops while the machine sleeps, so a long
// one-shot armed before a sleep would fire late by the length of the sleep.
// Re-arming at most this far out bounds that lag; a run before the boundary
// only re-arms.
export const WATCH_PAUSE_RECHECK_MS = 15 * 60_000;

export const WATCH_PAUSE_JOBS: Readonly<Record<string, BackgroundJob>> = {
  [WATCH_PAUSE_ALARM_NAME]: { run: (runner) => runner.runWatchPauseBoundary() },
};

// The enabled platforms whose session does not yet reflect the window at
// `now`: paused by it while it is over, or anything else while it applies.
function platformsOutOfStepWithWatchPause(
  settings: EngineSettings,
  sessions: Record<Platform, { reasonCode?: string }>,
  now: number,
): Platform[] {
  const paused = pausedBySchedule(settings, now);
  return PLATFORMS.filter(
    (platform) =>
      settings.platform[platform].enabled
      && paused !== (sessions[platform].reasonCode === "scheduled_pause"),
  );
}

export function createWatchPause<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  { lifecycleSlice }: Pick<ControllerSlices<S>, "lifecycleSlice">,
  calls: Pick<ControllerCalls<S>, "tickInBackground">,
): Pick<
  ControllerCalls<S>,
  "reconcileWatchPauseJob" | "rescheduleWatchPauseJob" | "runWatchPauseBoundary"
> {
  const { tickInBackground } = lateBound(calls);
  let reschedule: Promise<void> = Promise.resolve();

  async function reconcileWatchPauseJob(settings: EngineSettings, now = Date.now()): Promise<void> {
    const boundary = nextWatchPauseBoundary(settings.watchPauseSchedule, now);
    if (boundary === undefined) {
      await ports.jobs.cancel(WATCH_PAUSE_ALARM_NAME);
      return;
    }
    await ports.jobs.ensure(WATCH_PAUSE_ALARM_NAME, {
      when: Math.min(boundary + BOUNDARY_SLACK_MS, now + WATCH_PAUSE_RECHECK_MS),
    });
  }

  // Re-arms for the stored settings and ticks the platforms out of step. Runs
  // are serialized, and each reads the latest settings and state.
  function rescheduleWatchPauseJob(): Promise<void> {
    const run = reschedule.then(async () => {
      if (lifecycleSlice.controllerShutdown) return;
      const [settings, state] = await Promise.all([
        ports.storage.loadSettings(),
        ports.storage.loadState(),
      ]);
      const now = Date.now();
      await reconcileWatchPauseJob(settings, now);
      const platforms = platformsOutOfStepWithWatchPause(settings, state.sessions, now);
      if (platforms.length > 0) tickInBackground(platforms, "watch_pause");
    });
    reschedule = run.catch(() => undefined);
    return run;
  }

  return {
    reconcileWatchPauseJob,
    rescheduleWatchPauseJob,
    runWatchPauseBoundary: rescheduleWatchPauseJob,
  };
}
