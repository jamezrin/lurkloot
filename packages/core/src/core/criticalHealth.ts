import type { ActivityEvent, PageContextOpenReason } from "@lurkloot/shared/events";
import type { CriticalFailureReason, CriticalHealthState, FailureRecord } from "@lurkloot/shared/criticalHealth";
import { CRITICAL_HEALTH_RECORD_LIMIT, DEFAULT_CRITICAL_HEALTH } from "@lurkloot/shared/criticalHealth";
import type { Platform, SchedulerState } from "@lurkloot/shared/models";

// Deliberately conservative constants, not settings. The prompt tells the user
// the extension is broken; a false positive is worse than a late one.
export const FAILING_WINDOW_MS = 45 * 60 * 1000;
// A floor on observations, so a handful of ticks can never flag on wall-clock time alone.
// Under MAX_TICK_DELTA_MS below it is implied rather than binding (reaching the window takes
// FAILING_WINDOW_MS / MAX_TICK_DELTA_MS + 1 ticks); it is kept explicit so tightening either
// constant cannot silently reintroduce a low-evidence flag.
export const MIN_FAILING_TICKS = 6;
// A single tick may report a huge delta after the browser was suspended. Clamp it
// so wall-clock sleep can never substitute for observed failing time.
export const MAX_TICK_DELTA_MS = 5 * 60 * 1000;
export const TAB_CHURN_WINDOW_MS = 10 * 60 * 1000;
export const TAB_CHURN_LIMIT = 5;
export const COOLDOWN_MS = FAILING_WINDOW_MS;

export interface CriticalHealthObservation {
  at: number;
  // The tick ended in error. The scheduler sets this for platform backoff, for a
  // discovery/readProgress failure, and for any error thrown later in the farming
  // work (which is also what leaves the session in status "error"). A tick that
  // reached no conclusion at all — platform disabled, authentication unhealthy —
  // is NOT failing: it reports a neutral observation instead, so the pruning
  // still runs without charging failing time.
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

// A managed tab this extension opened. Only page contexts carry a PageContextOpenReason,
// so the union keeps watch-tab opens from having to invent one.
export type ManagedTabOpen =
  | { source: "page_context"; reason: PageContextOpenReason }
  | { source: "watch_tab" };

function breadcrumb(open: ManagedTabOpen): Omit<FailureRecord, "at" | "platform"> {
  return open.source === "page_context"
    ? { kind: "context_open", code: open.reason }
    : { kind: "watch_tab_open" };
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
): readonly FailureRecord[] {
  if (!record) return records;
  return [...records, { ...record, at: new Date(at).toISOString(), platform }].slice(-CRITICAL_HEALTH_RECORD_LIMIT);
}

function inCooldown(health: CriticalHealthState, at: number): boolean {
  return health.cooldownUntil !== undefined && at < Date.parse(health.cooldownUntil);
}

// The trim is only safe because `churning` tests `>= TAB_CHURN_LIMIT` against the same
// constant: keeping exactly TAB_CHURN_LIMIT stamps is enough to trip and to keep the
// breaker open. If either the limit or that comparison changes, this must change in step
// or the trim silently discards evidence.
function pruneOpens(opens: readonly string[], at: number): string[] {
  return opens.filter((stamp) => at - Date.parse(stamp) <= TAB_CHURN_WINDOW_MS).slice(-TAB_CHURN_LIMIT);
}

// While flagged the breaker stays open until the user dismisses. While unflagged it is
// held open only by live churn evidence, so the window drains on its own — an open
// breaker suppresses new opens — and the platform recovers without a prompt. This never
// opens the breaker; only crossing the threshold in recordManagedTabOpen does that.
function releaseBreaker(health: CriticalHealthState, opens: readonly string[]): boolean {
  if (health.status === "flagged") return health.breakerOpen;
  return health.breakerOpen && opens.length > 0;
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
  const lastObservedAt = health.lastObservedAt ? Date.parse(health.lastObservedAt) : undefined;
  // Re-evaluated every tick, driven purely by open timestamps ageing out of the window.
  // Deliberately NOT driven by the tick looking clean: an open breaker pauses the
  // platform, so ticks look clean by construction and that would undo the mitigation.
  const managedTabOpens = pruneOpens(health.managedTabOpens, observation.at);
  const breakerOpen = releaseBreaker(health, managedTabOpens);

  // Any of these means the platform is not in a continuous no-value episode.
  if (!observation.failing || observation.progressed || observation.preconditionBroke) {
    const reset: CriticalHealthState = {
      ...health,
      failingMs: 0,
      failingTicks: 0,
      lastObservedAt: new Date(observation.at).toISOString(),
      managedTabOpens,
      breakerOpen,
      records,
    };
    if (observation.watchedMinutes !== undefined) reset.lastWatchedMinutes = observation.watchedMinutes;
    return { state: withHealth(state, platform, reset) };
  }

  // Only the very first observation of a platform charges nothing, because the reset
  // branch above also stamps lastObservedAt. So the gap between the last clean tick and
  // the first failing tick counts as failing time, while a cold start under-counts by one
  // tick. Both are deliberate: charging the gap keeps a platform that fails right after a
  // clean tick honest, and under-counting a cold start only ever flags later, never sooner.
  const delta = lastObservedAt === undefined
    ? 0
    : Math.min(Math.max(observation.at - lastObservedAt, 0), MAX_TICK_DELTA_MS);
  const next: CriticalHealthState = {
    ...health,
    failingMs: health.failingMs + delta,
    failingTicks: health.failingTicks + 1,
    lastObservedAt: new Date(observation.at).toISOString(),
    managedTabOpens,
    breakerOpen,
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

export function recordManagedTabOpen(
  state: SchedulerState,
  platform: Platform,
  at: number,
  open: ManagedTabOpen,
): CriticalHealthTransition {
  const health = current(state, platform);
  // Page contexts and watch tabs share one window: a reopen storm of either kind is the
  // same symptom, and the real-world report that motivated this was watch tabs alone.
  const opens = pruneOpens([...health.managedTabOpens, new Date(at).toISOString()], at);
  const churning = opens.length >= TAB_CHURN_LIMIT;
  // The breaker is applied independently of the prompt: a platform already flagged for
  // another reason, or inside a post-dismissal cooldown, still needs the reopen loop
  // stopped even though it emits no new event. It never closes here — observeCriticalHealth
  // owns the release once the evidence ages out.
  const next: CriticalHealthState = {
    ...health,
    managedTabOpens: opens,
    breakerOpen: health.breakerOpen || churning,
    records: appendRecord(health.records, platform, at, breadcrumb(open)),
  };

  if (!churning || next.status === "flagged" || inCooldown(next, at)) {
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

// Task 7 gates creation of BOTH managed tab kinds on this.
export function isManagedTabBreakerOpen(state: SchedulerState, platform: Platform): boolean {
  return current(state, platform).breakerOpen;
}
