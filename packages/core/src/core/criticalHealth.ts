import type { ActivityEvent, PageContextOpenReason } from "@lurkloot/shared/events";
import type { CriticalFailureReason, CriticalHealthState, FailureRecord } from "@lurkloot/shared/criticalHealth";
import { CRITICAL_HEALTH_RECORD_LIMIT, DEFAULT_CRITICAL_HEALTH } from "@lurkloot/shared/criticalHealth";
import type { Platform, SchedulerState } from "@lurkloot/shared/models";

// Deliberately conservative constants, not settings. The prompt tells the user
// the extension is broken; a false positive is worse than a late one.
export const FAILING_WINDOW_MS = 45 * 60 * 1000;
export const MIN_FAILING_TICKS = 6;
// A single tick may report a huge delta after the browser was suspended. Clamp it
// so wall-clock sleep can never substitute for observed failing time.
export const MAX_TICK_DELTA_MS = 5 * 60 * 1000;
export const CONTEXT_CHURN_WINDOW_MS = 10 * 60 * 1000;
export const CONTEXT_CHURN_LIMIT = 5;
export const COOLDOWN_MS = FAILING_WINDOW_MS;

export interface CriticalHealthObservation {
  at: number;
  // The tick ended in error: session status "error", platform backoff, or
  // discovery/readProgress threw.
  failing: boolean;
  // watchedMinutes increased for the active reward this tick.
  progressed: boolean;
  // An accrual precondition broke mid-window (channel offline, category change,
  // heartbeat unhealthy, fallback, pause, manual watch, target switch).
  preconditionBroke: boolean;
  watchedMinutes?: number;
  record?: Omit<FailureRecord, "at" | "platform">;
}

export interface CriticalHealthTransition {
  state: SchedulerState;
  event?: ActivityEvent;
}

function current(state: SchedulerState, platform: Platform): CriticalHealthState {
  return state.criticalHealth?.[platform] ?? DEFAULT_CRITICAL_HEALTH;
}

function withHealth(state: SchedulerState, platform: Platform, health: CriticalHealthState): SchedulerState {
  return { ...state, criticalHealth: { ...state.criticalHealth, [platform]: health } };
}

function appendRecord(
  records: readonly FailureRecord[],
  platform: Platform,
  at: number,
  record: Omit<FailureRecord, "at" | "platform"> | undefined,
): FailureRecord[] {
  if (!record) return [...records];
  return [...records, { ...record, at: new Date(at).toISOString(), platform }].slice(-CRITICAL_HEALTH_RECORD_LIMIT);
}

function inCooldown(health: CriticalHealthState, at: number): boolean {
  return health.cooldownUntil !== undefined && at < Date.parse(health.cooldownUntil);
}

function flag(
  health: CriticalHealthState,
  platform: Platform,
  at: number,
  reason: CriticalFailureReason,
): { health: CriticalHealthState; event: ActivityEvent } {
  return {
    health: {
      ...health,
      status: "flagged",
      reason,
      flaggedAt: new Date(at).toISOString(),
      breakerOpen: reason === "page_context_churn" ? true : health.breakerOpen,
    },
    event: {
      category: "activity",
      code: "critical_failure_detected",
      level: "error",
      platform,
      data: { reason },
    },
  };
}

export function observeCriticalHealth(
  state: SchedulerState,
  platform: Platform,
  observation: CriticalHealthObservation,
): CriticalHealthTransition {
  const health = current(state, platform);
  const records = appendRecord(health.records, platform, observation.at, observation.record);
  const lastObservedAt = health.lastAccrualAt ? Date.parse(health.lastAccrualAt) : undefined;

  // Any of these means the platform is not in a continuous no-value episode.
  if (!observation.failing || observation.progressed || observation.preconditionBroke) {
    const reset: CriticalHealthState = {
      ...health,
      failingMs: 0,
      failingTicks: 0,
      lastAccrualAt: new Date(observation.at).toISOString(),
      records,
    };
    if (observation.watchedMinutes !== undefined) reset.lastWatchedMinutes = observation.watchedMinutes;
    return { state: withHealth(state, platform, reset) };
  }

  const delta = lastObservedAt === undefined
    ? 0
    : Math.min(Math.max(observation.at - lastObservedAt, 0), MAX_TICK_DELTA_MS);
  const next: CriticalHealthState = {
    ...health,
    failingMs: health.failingMs + delta,
    failingTicks: health.failingTicks + 1,
    lastAccrualAt: new Date(observation.at).toISOString(),
    records,
  };
  if (observation.watchedMinutes !== undefined) next.lastWatchedMinutes = observation.watchedMinutes;

  const ready = next.failingMs >= FAILING_WINDOW_MS && next.failingTicks >= MIN_FAILING_TICKS;
  if (!ready || next.status === "flagged" || inCooldown(next, observation.at)) {
    return { state: withHealth(state, platform, next) };
  }

  const flagged = flag(next, platform, observation.at, "no_progress");
  return { state: withHealth(state, platform, flagged.health), event: flagged.event };
}

export function recordPageContextOpen(
  state: SchedulerState,
  platform: Platform,
  at: number,
  reason: PageContextOpenReason,
): CriticalHealthTransition {
  const health = current(state, platform);
  const opens = [...health.contextOpens, new Date(at).toISOString()]
    .filter((stamp) => at - Date.parse(stamp) <= CONTEXT_CHURN_WINDOW_MS)
    .slice(-CONTEXT_CHURN_LIMIT);
  const next: CriticalHealthState = {
    ...health,
    contextOpens: opens,
    records: appendRecord(health.records, platform, at, { kind: "context_open", code: reason }),
  };

  if (opens.length < CONTEXT_CHURN_LIMIT || next.status === "flagged" || inCooldown(next, at)) {
    return { state: withHealth(state, platform, next) };
  }

  const flagged = flag(next, platform, at, "page_context_churn");
  return { state: withHealth(state, platform, flagged.health), event: flagged.event };
}

export function dismissCriticalFailure(
  state: SchedulerState,
  platform: Platform,
  at: number,
): CriticalHealthTransition {
  const health = current(state, platform);
  if (health.status !== "flagged") return { state };

  const reason = health.reason ?? "no_progress";
  const next: CriticalHealthState = {
    ...DEFAULT_CRITICAL_HEALTH,
    records: health.records,
    dismissedAt: new Date(at).toISOString(),
    cooldownUntil: new Date(at + COOLDOWN_MS).toISOString(),
  };

  return {
    state: withHealth(state, platform, next),
    event: {
      category: "activity",
      code: "critical_failure_cleared",
      level: "info",
      platform,
      data: { reason },
    },
  };
}

export function isPageContextBreakerOpen(state: SchedulerState, platform: Platform): boolean {
  return current(state, platform).breakerOpen;
}
