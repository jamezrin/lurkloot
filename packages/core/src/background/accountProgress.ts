import type {
  AccountProgressPoll,
  EngineSettings,
  Platform,
  SchedulerState,
} from "@lurkloot/shared/models";
import { errorMessage } from "@lurkloot/shared/errors";
import type { PlatformAdapter } from "../platforms/adapter";
import { ACCOUNT_PROGRESS_ALARM_NAME, PLATFORMS } from "./constants";
import { type ControllerSlices, lateBound } from "./context";
import type { BackgroundHostPorts } from "./hostPorts";
import type { BackgroundJob } from "./jobs";
import type { ControllerCalls } from "./types";

// The account-progress service: reads each platform's own account progress
// (Kick: viewer level and watch streak) on its own job, never inside a tick, so
// a slow platform endpoint cannot hold a tick up. Platform-neutral: what is
// read, and what it means, belongs to the adapter's optional
// fetchAccountProgress; this stores the result as given and the popup's
// per-platform view renders it.

// A level or streak moves with watch time; ten minutes is fresh enough.
export const ACCOUNT_PROGRESS_POLL_INTERVAL_MS = 10 * 60 * 1000;
// The job only compares the stored stamp until a read is due, so it can wake
// every minute: a sign-in, a restart or a platform turned on shows progress
// within a minute while the platform is still read at most every ten.
export const ACCOUNT_PROGRESS_JOB_PERIOD_MINUTES = 1;

export function accountProgressPollDue(
  state: SchedulerState,
  platform: Platform,
  now: number,
): boolean {
  const last = Date.parse(state.accountProgress?.[platform]?.lastCheckedAt ?? "");
  // A stamp in the future means the clock moved backwards; treat it as stale.
  if (!Number.isFinite(last) || last > now) return true;
  return now - last >= ACCOUNT_PROGRESS_POLL_INTERVAL_MS;
}

// Whether a platform's progress is worth reading now: farming on, signed in,
// and due. Manual watching does not pause it; progress is the account's.
export function accountProgressWanted(
  settings: EngineSettings,
  state: SchedulerState,
  platform: Platform,
  now: number,
): boolean {
  return (
    settings.platform[platform].enabled
    && state.authHealth[platform].status === "healthy"
    && accountProgressPollDue(state, platform, now)
  );
}

export const ACCOUNT_PROGRESS_JOBS: Readonly<Record<string, BackgroundJob>> = {
  [ACCOUNT_PROGRESS_ALARM_NAME]: { run: (runner) => runner.runAccountProgressPolls() },
};

export function createAccountProgress<S extends EngineSettings>(
  ports: BackgroundHostPorts<S>,
  { lifecycleSlice }: Pick<ControllerSlices<S>, "lifecycleSlice">,
  calls: Pick<
    ControllerCalls<S>,
    | "createAdapter"
    | "persistPlatformState"
    | "reportBestEffort"
    | "withEventCollector"
    | "withStateLock"
  >,
): Pick<
  ControllerCalls<S>,
  "abortAccountProgressPolls" | "ensureAccountProgressJob" | "runAccountProgressPolls"
> {
  const {
    createAdapter,
    persistPlatformState,
    reportBestEffort,
    withEventCollector,
    withStateLock,
  } = lateBound(calls);
  // One read per platform at a time: a fire that lands while the last read is
  // still out skips that platform rather than stacking requests.
  const reading = new Map<Platform, AbortController>();
  // Platforms whose adapter has no account progress. A platform's adapter
  // either offers the read or does not, so it is built once to find out rather
  // than on every wake.
  const unsupported = new Set<Platform>();

  async function ensureAccountProgressJob(): Promise<void> {
    await ports.jobs.ensure(ACCOUNT_PROGRESS_ALARM_NAME, {
      periodInMinutes: ACCOUNT_PROGRESS_JOB_PERIOD_MINUTES,
    });
  }

  function abortAccountProgressPolls(reason: string): void {
    for (const operation of reading.values()) operation.abort(new Error(reason));
  }

  async function runAccountProgressPolls(): Promise<void> {
    if (lifecycleSlice.controllerShutdown) return;
    const [settings, state] = await Promise.all([
      ports.storage.loadSettings(),
      ports.storage.loadState(),
    ]);
    const now = Date.now();
    await Promise.all(
      PLATFORMS.filter(
        (platform) =>
          !unsupported.has(platform)
          && !reading.has(platform)
          && accountProgressWanted(settings, state, platform, now),
      ).map((platform) => readPlatform(platform, settings)),
    );
  }

  async function readPlatform(platform: Platform, settings: S): Promise<void> {
    const operation = new AbortController();
    reading.set(platform, operation);
    try {
      await withEventCollector(async (emit, events) => {
        let adapter: PlatformAdapter | undefined;
        const checkedAt = new Date().toISOString();
        let read: Pick<AccountProgressPoll, "progress" | "fetchedAt"> = {};
        try {
          adapter = createAdapter(platform, settings, emit);
          if (!adapter.fetchAccountProgress) {
            unsupported.add(platform);
            return;
          }
          const progress = await adapter.fetchAccountProgress({ signal: operation.signal });
          if (progress) read = { progress, fetchedAt: checkedAt };
        } catch (error) {
          if (operation.signal.aborted) return;
          // Display only: a failure is never an auth status, a platform error or
          // a backoff. The stamp still moves, so it is retried next interval.
          emit({
            category: "diagnostic",
            platform,
            level: "debug",
            message: `Account progress read failed: ${errorMessage(error)}`,
          });
        }
        adapter?.flushRouteDiagnostics?.(emit);
        if (operation.signal.aborted || lifecycleSlice.controllerShutdown) return;
        // Committed onto the latest state, keeping the last good read when this
        // one read nothing.
        await withStateLock(async () => {
          const latest = await ports.storage.loadState();
          const previous = latest.accountProgress?.[platform];
          await persistPlatformState(
            platform,
            {
              ...latest,
              accountProgress: {
                ...latest.accountProgress,
                [platform]: { ...previous, lastCheckedAt: checkedAt, ...read },
              },
            },
            () => !operation.signal.aborted,
          );
        }, [platform]);
        await reportBestEffort(events);
      });
    } catch (error) {
      if (!operation.signal.aborted) {
        await reportBestEffort([
          {
            category: "diagnostic",
            platform,
            level: "debug",
            message: `Account progress commit failed: ${errorMessage(error)}`,
          },
        ]);
      }
    } finally {
      reading.delete(platform);
    }
  }

  return { abortAccountProgressPolls, ensureAccountProgressJob, runAccountProgressPolls };
}
