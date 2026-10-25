import type {
  ChannelCandidate,
  EngineSettings,
  Platform,
  SchedulerState,
  WatchSession,
  WatchStreakAttempt,
  WatchStreakOutcome,
  WatchStreakRowStatus,
  WatchStreakState,
} from "@lurkloot/shared/models";
import { WATCH_STREAK_BUDGET_MINUTES, watchStreakChannelsFor } from "@lurkloot/shared/settings";
import { isRecord } from "@lurkloot/shared/records";

// Watch-streak maintenance (#897). The rules for one attempt per signed-in
// account, channel and broadcast: how healthy watching accrues, when an attempt
// ends, and which maintained Idle Watchlist rows the scheduler may still pick.
// Platform-free: the platform reports a payout as an observation, and the tick
// reports the session it watched.

// Healthy watching an attempt gets before it ends as not confirmed. A safety
// budget, not a claim about the platform's own credit threshold.
export const WATCH_STREAK_BUDGET_MS = WATCH_STREAK_BUDGET_MINUTES * 60_000;
// Ticks an attempt's channel may be selected but unhealthy (a tab that never
// plays, a heartbeat that keeps failing) before it ends as not confirmed, so a
// row that never accrues cannot reopen forever.
export const WATCH_STREAK_MAX_UNHEALTHY_CHECKS = 10;
// The most one observation may add. Ticks are at least a minute apart; a longer
// gap means a suspended worker or a slow tick, which never counts as watching.
export const WATCH_STREAK_MAX_ACCRUAL_STEP_MS = 2 * 60_000;
// A payout reported this long before an attempt started still belongs to it:
// the platform can credit within the broadcast's first minutes, before the
// first tick that observed this account watching it.
export const WATCH_STREAK_CREDIT_LEAD_MS = 30 * 60_000;
// And a payout this long after an attempt was last observed still belongs to
// it: ticks can be several minutes apart (pollIntervalMinutes).
export const WATCH_STREAK_CREDIT_LAG_MS = 10 * 60_000;
export const WATCH_STREAK_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const WATCH_STREAK_MAX_ATTEMPTS = 200;

const OUTCOME_RANK: Record<WatchStreakOutcome, number> = {
  pending: 0,
  not_confirmed: 1,
  credited: 2,
};
const ROW_STATUSES = new Set<WatchStreakRowStatus>([
  "pending",
  "watching",
  "credited",
  "not_confirmed",
  "unavailable",
]);
const PLATFORM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function watchStreakAttemptKey(
  attempt: Pick<WatchStreakAttempt, "accountId" | "channelId" | "broadcastId">,
): string {
  return `${attempt.accountId}:${attempt.channelId}:${attempt.broadcastId}`;
}

export function isValidPlatformId(value: unknown): value is string {
  return typeof value === "string" && PLATFORM_ID.test(value);
}

function emptyState(): WatchStreakState {
  return { attempts: [] };
}

export function watchStreakStateFor(state: SchedulerState, platform: Platform): WatchStreakState {
  return state.watchStreaks?.[platform] ?? emptyState();
}

function findAttempt(
  streaks: WatchStreakState,
  key: string,
): { attempt: WatchStreakAttempt; index: number } | undefined {
  const index = streaks.attempts.findIndex((attempt) => watchStreakAttemptKey(attempt) === key);
  return index < 0 ? undefined : { attempt: streaks.attempts[index]!, index };
}

function withAttempt(
  streaks: WatchStreakState,
  attempt: WatchStreakAttempt,
  index: number | undefined,
): WatchStreakState {
  const attempts = [...streaks.attempts];
  if (index === undefined) attempts.push(attempt);
  else attempts[index] = attempt;
  return { ...streaks, attempts };
}

// The identity the session's watch would be accrued under, when it has one.
export function sessionStreakIdentity(
  session: WatchSession,
  accountId: string | undefined,
): Pick<WatchStreakAttempt, "accountId" | "channelId" | "broadcastId" | "username"> | undefined {
  const channel = session.status === "watching" ? session.channel : undefined;
  if (
    !channel
    || !isValidPlatformId(accountId)
    || !isValidPlatformId(channel.channelId)
    || !isValidPlatformId(channel.broadcastId)
  )
    return undefined;
  return {
    accountId,
    channelId: channel.channelId,
    broadcastId: channel.broadcastId,
    username: channel.username.toLowerCase(),
  };
}

export interface WatchStreakAccrualInput {
  // The session as the previous tick left it: what was watched since then.
  session: WatchSession;
  accountId: string | undefined;
  // Maintained channels (lowercased logins).
  maintained: ReadonlySet<string>;
  // Whether that watch is healthy now (heartbeat or playback).
  healthy: boolean;
  // A watch that just started (a tab in its playback grace, a tabless watch
  // with no heartbeat yet) is not healthy yet, but not failing either: it
  // neither accrues nor counts towards the failure bound.
  settling?: boolean;
  // A manual watch or another pause: LurkLoot is not the one watching.
  paused: boolean;
  now: number;
}

// Accrues the time since the last observation to the watched channel's
// attempt. Only a healthy watch of the same channel and broadcast that was
// already observed counts, capped per step. Starts the attempt on the first
// observation; ends it when the budget or the failure bound runs out. A
// terminal attempt is never reopened.
export function accrueWatchStreak(
  streaks: WatchStreakState,
  input: WatchStreakAccrualInput,
): WatchStreakState {
  const identity = input.paused ? undefined : sessionStreakIdentity(input.session, input.accountId);
  if (!identity || !input.maintained.has(identity.username)) {
    return streaks.observing ? { ...streaks, observing: undefined } : streaks;
  }
  const key = watchStreakAttemptKey(identity);
  const nowIso = new Date(input.now).toISOString();
  const found = findAttempt(streaks, key);
  if (found && found.attempt.outcome !== "pending") {
    return streaks.observing ? { ...streaks, observing: undefined } : streaks;
  }
  const attempt: WatchStreakAttempt = found
    ? { ...found.attempt }
    : {
        ...identity,
        outcome: "pending",
        watchedMs: 0,
        unhealthyChecks: 0,
        startedAt: nowIso,
        updatedAt: nowIso,
      };
  let observing: WatchStreakState["observing"];
  if (input.healthy) {
    const since = streaks.observing?.key === key ? Date.parse(streaks.observing.at) : Number.NaN;
    const elapsed = input.now - since;
    if (Number.isFinite(elapsed) && elapsed > 0) {
      attempt.watchedMs += Math.min(elapsed, WATCH_STREAK_MAX_ACCRUAL_STEP_MS);
    }
    observing = { key, at: nowIso };
  } else {
    if (!input.settling) attempt.unhealthyChecks += 1;
    observing = undefined;
  }
  attempt.updatedAt = nowIso;
  if (
    attempt.watchedMs >= WATCH_STREAK_BUDGET_MS
    || attempt.unhealthyChecks >= WATCH_STREAK_MAX_UNHEALTHY_CHECKS
  ) {
    attempt.outcome = "not_confirmed";
    attempt.completedAt = nowIso;
    observing = undefined;
  }
  return { ...withAttempt(streaks, attempt, found?.index), observing };
}

export interface WatchStreakCreditObservation {
  accountId: string;
  channelId: string;
  // When the platform reported the payout.
  at: number;
}

// Records a payout against the account's latest attempt on that channel. The
// payout names no broadcast, so it is attributed only to an attempt that was
// running then: started no more than WATCH_STREAK_CREDIT_LEAD_MS after it, and
// last observed no more than WATCH_STREAK_CREDIT_LAG_MS before it. Late credit for an
// attempt whose budget just ran out still upgrades it. Returns undefined when
// nothing matched, so a stale,
// unrelated or other account's payout changes nothing.
export function recordWatchStreakCredit(
  streaks: WatchStreakState,
  observation: WatchStreakCreditObservation,
): { state: WatchStreakState; attempt: WatchStreakAttempt } | undefined {
  if (
    !isValidPlatformId(observation.accountId)
    || !isValidPlatformId(observation.channelId)
    || !Number.isFinite(observation.at)
  )
    return undefined;
  let latest: { attempt: WatchStreakAttempt; index: number } | undefined;
  streaks.attempts.forEach((attempt, index) => {
    if (attempt.accountId !== observation.accountId || attempt.channelId !== observation.channelId)
      return;
    if (!latest || Date.parse(attempt.startedAt) > Date.parse(latest.attempt.startedAt))
      latest = { attempt, index };
  });
  if (!latest || latest.attempt.outcome === "credited") return undefined;
  const startedAt = Date.parse(latest.attempt.startedAt);
  if (!(observation.at >= startedAt - WATCH_STREAK_CREDIT_LEAD_MS)) return undefined;
  // Not after the attempt stopped being observed: a payout long after the
  // attempt's last update belongs to a later broadcast it never saw.
  const lastSeen = Date.parse(latest.attempt.completedAt ?? latest.attempt.updatedAt);
  if (observation.at > lastSeen + WATCH_STREAK_CREDIT_LAG_MS) return undefined;
  const at = new Date(observation.at).toISOString();
  const attempt: WatchStreakAttempt = {
    ...latest.attempt,
    outcome: "credited",
    updatedAt: at,
    completedAt: at,
  };
  const state = withAttempt(streaks, attempt, latest.index);
  return {
    attempt,
    state:
      state.observing?.key === watchStreakAttemptKey(attempt)
        ? { ...state, observing: undefined }
        : state,
  };
}

export type WatchStreakVerdict = "pending" | "credited" | "not_confirmed" | "unavailable";

// What the scheduler reads for a maintained Idle Watchlist row. One plan is
// built per selection from the same state, so every path that picks or keeps
// an Idle row agrees on it.
export interface IdleWatchlistStreakPlan {
  // Maintained rows, lowercased, in watchlist order.
  readonly maintained: readonly string[];
  // The maintained rows tried ahead of the rest. Empty when the payout cannot
  // be observed or attributed, so those rows keep their ordinary place.
  readonly prioritized: readonly string[];
  // The checked candidate's attempt for its current broadcast.
  verdict(candidate: ChannelCandidate): WatchStreakVerdict;
}

export const NO_WATCH_STREAKS: IdleWatchlistStreakPlan = {
  maintained: [],
  prioritized: [],
  verdict: () => "unavailable",
};

export function watchStreakPlan(
  platform: Platform,
  settings: EngineSettings,
  state: SchedulerState,
  observerAvailable: boolean,
): IdleWatchlistStreakPlan {
  const maintained = watchStreakChannelsFor(settings, platform);
  if (maintained.length === 0) return NO_WATCH_STREAKS;
  const streaks = watchStreakStateFor(state, platform);
  const health = state.authHealth[platform];
  const accountId = health.status === "healthy" ? health.accountId : undefined;
  return {
    maintained,
    prioritized: observerAvailable && isValidPlatformId(accountId) ? maintained : [],
    verdict(candidate) {
      if (!observerAvailable || !isValidPlatformId(accountId)) return "unavailable";
      if (!isValidPlatformId(candidate.channelId) || !isValidPlatformId(candidate.broadcastId))
        return "unavailable";
      const found = findAttempt(
        streaks,
        watchStreakAttemptKey({
          accountId,
          channelId: candidate.channelId,
          broadcastId: candidate.broadcastId,
        }),
      );
      return found?.attempt.outcome ?? "pending";
    },
  };
}

// The Idle Watchlist in the order its rows are tried: maintained rows first,
// then the rest, each group in the user's order. Discovery observes the rows in
// this order too, so a long ordinary list never hides a maintained row.
export function orderIdleWatchlist(
  channels: readonly string[],
  maintained: readonly string[],
): string[] {
  if (maintained.length === 0) return [...channels];
  const set = new Set(maintained);
  return [
    ...channels.filter((channel) => set.has(channel)),
    ...channels.filter((channel) => !set.has(channel)),
  ];
}

// Merges a tick's streak state into the stored one. Attempts are combined by
// key and only move forward (outcome, watched time, failures), so a payout
// committed while a tick ran survives that tick's commit. The tick owns the
// observation stamp and the row statuses.
export function mergeWatchStreakState(
  stored: WatchStreakState | undefined,
  next: WatchStreakState | undefined,
): WatchStreakState | undefined {
  if (!stored) return next;
  if (!next) return stored;
  const byKey = new Map<string, WatchStreakAttempt>();
  for (const attempt of next.attempts) byKey.set(watchStreakAttemptKey(attempt), attempt);
  for (const attempt of stored.attempts) {
    const key = watchStreakAttemptKey(attempt);
    const other = byKey.get(key);
    byKey.set(key, other ? mergeAttempt(attempt, other) : attempt);
  }
  const attempts = [...byKey.values()].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
  );
  // Pruned again, so an attempt the tick pruned is not restored from storage.
  const merged = pruneWatchStreaks({ ...next, attempts }, Date.now());
  if (
    merged.observing
    && attempts.some(
      (attempt) =>
        watchStreakAttemptKey(attempt) === merged.observing?.key && attempt.outcome !== "pending",
    )
  )
    merged.observing = undefined;
  return merged;
}

function mergeAttempt(left: WatchStreakAttempt, right: WatchStreakAttempt): WatchStreakAttempt {
  const winner = OUTCOME_RANK[right.outcome] > OUTCOME_RANK[left.outcome] ? right : left;
  return {
    ...winner,
    watchedMs: Math.max(left.watchedMs, right.watchedMs),
    unhealthyChecks: Math.max(left.unhealthyChecks, right.unhealthyChecks),
    startedAt:
      Date.parse(left.startedAt) <= Date.parse(right.startedAt) ? left.startedAt : right.startedAt,
    updatedAt:
      Date.parse(left.updatedAt) >= Date.parse(right.updatedAt) ? left.updatedAt : right.updatedAt,
  };
}

// Drops attempts older than the retention window and keeps at most the newest
// WATCH_STREAK_MAX_ATTEMPTS, so the record cannot grow without bound.
export function pruneWatchStreaks(streaks: WatchStreakState, now: number): WatchStreakState {
  const kept = streaks.attempts
    .filter((attempt) => now - Date.parse(attempt.updatedAt) <= WATCH_STREAK_RETENTION_MS)
    .slice(-WATCH_STREAK_MAX_ATTEMPTS);
  if (kept.length === streaks.attempts.length) return streaks;
  const keys = new Set(kept.map(watchStreakAttemptKey));
  return {
    ...streaks,
    attempts: kept,
    observing: streaks.observing && keys.has(streaks.observing.key) ? streaks.observing : undefined,
  };
}

// The row statuses the popup shows. A row with no live broadcast keeps the
// status of its latest attempt, or reads as pending.
export function watchStreakRowStatuses(
  plan: IdleWatchlistStreakPlan,
  streaks: WatchStreakState,
  accountId: string | undefined,
  observerAvailable: boolean,
  liveCandidates: ReadonlyMap<string, ChannelCandidate>,
  watching: ChannelCandidate | undefined,
): Record<string, WatchStreakRowStatus> {
  const rows: Record<string, WatchStreakRowStatus> = {};
  for (const username of plan.maintained) {
    if (!observerAvailable || !isValidPlatformId(accountId)) {
      rows[username] = "unavailable";
      continue;
    }
    const live = liveCandidates.get(username);
    if (live) {
      const verdict = plan.verdict(live);
      rows[username] =
        verdict === "pending"
          ? watching?.username.toLowerCase() === username
            ? "watching"
            : "pending"
          : verdict;
      continue;
    }
    const latest = streaks.attempts
      .filter((attempt) => attempt.accountId === accountId && attempt.username === username)
      .at(-1);
    rows[username] = latest && latest.outcome !== "pending" ? latest.outcome : "pending";
  }
  return rows;
}

function normalizeAttempt(value: unknown): WatchStreakAttempt | undefined {
  if (!isRecord(value)) return undefined;
  const { accountId, channelId, broadcastId, username, outcome, startedAt, updatedAt } = value;
  if (
    !isValidPlatformId(accountId)
    || !isValidPlatformId(channelId)
    || !isValidPlatformId(broadcastId)
    || typeof username !== "string"
    || typeof outcome !== "string"
    || !(outcome in OUTCOME_RANK)
    || typeof startedAt !== "string"
    || !Number.isFinite(Date.parse(startedAt))
    || typeof updatedAt !== "string"
    || !Number.isFinite(Date.parse(updatedAt))
  )
    return undefined;
  const count = (raw: unknown) =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  const attempt: WatchStreakAttempt = {
    accountId,
    channelId,
    broadcastId,
    username: username.toLowerCase().slice(0, 64),
    outcome: outcome as WatchStreakOutcome,
    watchedMs: count(value.watchedMs),
    unhealthyChecks: count(value.unhealthyChecks),
    startedAt,
    updatedAt,
  };
  if (typeof value.completedAt === "string" && Number.isFinite(Date.parse(value.completedAt)))
    attempt.completedAt = value.completedAt;
  return attempt;
}

// Restores stored streak state, dropping anything malformed.
export function normalizeWatchStreakState(value: unknown): WatchStreakState | undefined {
  if (!isRecord(value)) return undefined;
  const attempts = Array.isArray(value.attempts)
    ? value.attempts.flatMap((attempt) => normalizeAttempt(attempt) ?? [])
    : [];
  const state: WatchStreakState = { attempts: attempts.slice(-WATCH_STREAK_MAX_ATTEMPTS) };
  const observing = value.observing;
  if (
    isRecord(observing)
    && typeof observing.key === "string"
    && typeof observing.at === "string"
    && Number.isFinite(Date.parse(observing.at))
  )
    state.observing = { key: observing.key, at: observing.at };
  if (isRecord(value.rows)) {
    const rows: Record<string, WatchStreakRowStatus> = {};
    for (const [username, status] of Object.entries(value.rows)) {
      if (ROW_STATUSES.has(status as WatchStreakRowStatus))
        rows[username] = status as WatchStreakRowStatus;
    }
    state.rows = rows;
  }
  if (typeof value.observerAvailable === "boolean")
    state.observerAvailable = value.observerAvailable;
  return state;
}
