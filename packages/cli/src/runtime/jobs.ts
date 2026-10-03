import { MIN_JOB_PERIOD_MINUTES, type JobSchedule, type JobSchedulerPort } from "@lurkloot/core/controller";

export interface TimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const NODE_TIMERS: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface NodeJobScheduler extends JobSchedulerPort {
  // Stops every job. Nothing fires afterwards, and ensure schedules nothing.
  dispose(): void;
}

interface NodeJob {
  readonly schedule: JobSchedule;
  scheduledTime: number;
  handle: unknown;
}

// The CLI's job scheduler port (#593), backed by Node timers, with the
// semantics documented in @lurkloot/core's jobs.ts:
// - periods shorter than MIN_JOB_PERIOD_MINUTES are clamped, as browser alarms are;
// - ensure replaces a job of the same name and restarts its period;
// - a one-shot job is removed before it fires; a past `when` fires at once;
// - a periodic job re-arms from the moment it fires, so a blocked event loop or
//   a suspended machine yields one late fire, never a burst of missed ones;
// - `onFire` is called without waiting for a previous run: jobs coalesce their
//   own overlapping runs;
// - timers end with the process, so the CLI re-ensures its jobs on startup.
export function createNodeJobScheduler(
  onFire: (name: string) => void,
  timers: TimerApi = NODE_TIMERS,
): NodeJobScheduler {
  const jobs = new Map<string, NodeJob>();
  let disposed = false;

  function arm(name: string, job: NodeJob, delayMs: number): void {
    job.scheduledTime = timers.now() + delayMs;
    job.handle = timers.setTimeout(() => {
      if (disposed || jobs.get(name) !== job) return;
      if ("when" in job.schedule) {
        jobs.delete(name);
      } else {
        arm(name, job, periodMs(job.schedule.periodInMinutes));
      }
      onFire(name);
    }, delayMs);
  }

  return {
    ensure: async (name, schedule) => {
      if (disposed) return;
      const existing = jobs.get(name);
      if (existing) timers.clearTimeout(existing.handle);
      const job: NodeJob = { schedule, scheduledTime: 0, handle: undefined };
      jobs.set(name, job);
      arm(name, job, "when" in schedule
        ? Math.max(0, schedule.when - timers.now())
        : periodMs(schedule.periodInMinutes));
    },
    cancel: async (name) => {
      const job = jobs.get(name);
      if (!job) return false;
      timers.clearTimeout(job.handle);
      jobs.delete(name);
      return true;
    },
    get: async (name) => {
      const job = jobs.get(name);
      return job ? { scheduledTime: job.scheduledTime } : undefined;
    },
    dispose: () => {
      disposed = true;
      for (const job of jobs.values()) timers.clearTimeout(job.handle);
      jobs.clear();
    },
  };
}

function periodMs(periodInMinutes: number): number {
  return Math.max(MIN_JOB_PERIOD_MINUTES, periodInMinutes) * 60_000;
}
