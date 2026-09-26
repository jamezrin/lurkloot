import type { Platform } from "@lurkloot/shared/models";
import {
  KICK_ALARM_NAME,
  KICK_CHALLENGES_ALARM_NAME,
  KICK_DROP_CLAIMS_ALARM_NAME,
  TWITCH_ALARM_NAME,
  TWITCH_CHANNEL_POINTS_ALARM_NAME,
  TWITCH_DROP_CLAIMS_ALARM_NAME,
  TWITCH_INTEGRITY_ALARM_NAME,
  WATCH_ALARM_NAME,
} from "./constants";
import type { HostCapabilities } from "./hostPorts";

// The job scheduler port (#593): the only way the engine schedules work. The
// extension implements it with browser.alarms, the CLI with Node timers.
//
// Semantics every implementation keeps, and every job must be correct under:
// - Minimum period: MIN_JOB_PERIOD_MINUTES. browser.alarms clamps shorter
//   periods on its own; the Node scheduler clamps to the same minimum.
// - ensure replaces: after it resolves, exactly one job of that name exists,
//   with that schedule. Ensuring an existing job again restarts its period.
// - cancel is idempotent and reports whether a job existed.
// - A one-shot job (`when`) is gone once it has fired. A `when` in the past
//   fires as soon as possible.
// - Late and missed fires: a host that was suspended (a sleeping service worker
//   or machine, a blocked event loop) fires a periodic job once when it wakes,
//   not once per missed period. Fires carry no time, so a job reads the clock.
// - Duplicate and overlapping fires: a job can fire again while its previous
//   run is still in progress, and a host can deliver the same fire twice. The
//   runs coalesce in the services (tick admission, heartbeat lanes), never in
//   the scheduler.
// - Persistence: browser alarms survive a service-worker restart; Node timers
//   end with the process. A host re-ensures its jobs on startup, and `get`
//   tells a job whether a schedule survived (Twitch integrity refresh).
export type JobSchedule = { periodInMinutes: number } | { when: number };

export interface ScheduledJob {
  // Epoch milliseconds of the next fire.
  scheduledTime: number;
}

export interface JobSchedulerPort {
  ensure(name: string, schedule: JobSchedule): Promise<void>;
  cancel(name: string): Promise<boolean>;
  get(name: string): Promise<ScheduledJob | undefined>;
}

export const MIN_JOB_PERIOD_MINUTES = 0.5;

export interface JobRunner {
  tickAndHandOff(platforms: Platform[], trigger: "alarm"): Promise<unknown>;
  runWatchHeartbeat(): Promise<void>;
  runTwitchChannelPointsClaim(): Promise<void>;
  runDropClaims(platform: Platform): Promise<void>;
  runKickChallengeClaims(): Promise<void>;
  runTwitchIntegrityRefresh(): Promise<void>;
}

export interface BackgroundJob {
  run(runner: JobRunner): Promise<unknown>;
  // The capability a host must declare for the job to run. Without it the job
  // is inert: ensure schedules nothing and a fire does nothing.
  requires?: keyof HostCapabilities;
}

// Every job the engine schedules. Services own their entries as they are
// extracted (#586–#590, #597).
export const BACKGROUND_JOBS: Readonly<Record<string, BackgroundJob>> = {
  [TWITCH_ALARM_NAME]: { run: (runner) => runner.tickAndHandOff(["twitch"], "alarm") },
  [KICK_ALARM_NAME]: { run: (runner) => runner.tickAndHandOff(["kick"], "alarm") },
  [WATCH_ALARM_NAME]: { run: (runner) => runner.runWatchHeartbeat() },
  [TWITCH_CHANNEL_POINTS_ALARM_NAME]: {
    run: (runner) => runner.runTwitchChannelPointsClaim(),
    requires: "twitchChannelPointsJob",
  },
  // The claim jobs claim for a manually watched tab, which needs browser tabs.
  [TWITCH_DROP_CLAIMS_ALARM_NAME]: { run: (runner) => runner.runDropClaims("twitch"), requires: "browserTabs" },
  [KICK_DROP_CLAIMS_ALARM_NAME]: { run: (runner) => runner.runDropClaims("kick"), requires: "browserTabs" },
  [KICK_CHALLENGES_ALARM_NAME]: { run: (runner) => runner.runKickChallengeClaims(), requires: "browserTabs" },
  [TWITCH_INTEGRITY_ALARM_NAME]: {
    run: (runner) => runner.runTwitchIntegrityRefresh(),
    requires: "twitchIntegrityCapture",
  },
};

export function jobIsInert(name: string, capabilities: HostCapabilities): boolean {
  const requires = BACKGROUND_JOBS[name]?.requires;
  return requires !== undefined && !capabilities[requires];
}

// The host's scheduler as the engine uses it: inert jobs are never scheduled.
// Cancelling still reaches the host, so a schedule left over from a build that
// had the capability is cleared.
export function capabilityScopedJobs(jobs: JobSchedulerPort, capabilities: HostCapabilities): JobSchedulerPort {
  return {
    ensure: async (name, schedule) => {
      if (jobIsInert(name, capabilities)) return;
      await jobs.ensure(name, schedule);
    },
    cancel: (name) => jobs.cancel(name),
    get: async (name) => (jobIsInert(name, capabilities) ? undefined : jobs.get(name)),
  };
}

// Runs the job a host fired. Unknown and inert jobs do nothing.
export function runBackgroundJob(
  name: string,
  runner: JobRunner,
  capabilities: HostCapabilities,
): Promise<unknown> | undefined {
  const job = BACKGROUND_JOBS[name];
  if (!job || jobIsInert(name, capabilities)) return undefined;
  return job.run(runner);
}
