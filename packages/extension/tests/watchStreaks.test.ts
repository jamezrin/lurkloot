import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STATE, mergeSchedulerState } from "@lurkloot/core/defaults";
import {
  accrueWatchStreak,
  mergeWatchStreakState,
  normalizeWatchStreakState,
  orderIdleWatchlist,
  pruneWatchStreaks,
  recordWatchStreakCredit,
  watchStreakPlan,
  watchStreakPolicy,
  WATCH_STREAK_MAX_ATTEMPTS,
  WATCH_STREAK_RETENTION_MS,
} from "@lurkloot/core/watchStreaks";
import { mergePlatformState } from "@lurkloot/core/background/platformState";
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  mergeSettings,
  WATCH_STREAK_TUNING_BOUNDS,
  type WatchStreakTuning,
} from "@lurkloot/shared/settings";
import {
  buildSettingsExportPayload,
  parseSettingsImportPayload,
} from "@lurkloot/shared/settingsExport";
import type {
  ChannelCandidate,
  DropCampaign,
  ExtensionSettings,
  WatchSourceId,
  SchedulerState,
  WatchSession,
  WatchStreakState,
} from "@lurkloot/shared/models";
import { chooseCampaignDecision } from "@lurkloot/core/scheduler";
import type { EventEmitter } from "@lurkloot/shared/events";
import type { IdleWatchlistStreakPlan, WatchStreakVerdict } from "@lurkloot/core/watchStreaks";
import {
  runSchedulerTick,
  type SchedulerTestAdapter,
  type SchedulerTickTestOptions,
} from "./helpers/schedulerTick";

const ACCOUNT = "1000";
// The policy at a poll interval, with the default tuning unless overridden.
function policyAt(
  pollIntervalMinutes: number,
  tuning: Partial<WatchStreakTuning> = {},
): ReturnType<typeof watchStreakPolicy> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.pollIntervalMinutes = pollIntervalMinutes;
  Object.assign(settings.platform.twitch, tuning);
  return watchStreakPolicy(settings, "twitch");
}
const POLICY = policyAt(1);
const WATCH_STREAK_BUDGET_MS = POLICY.budgetMs;
const WATCH_STREAK_MAX_ROUNDS = POLICY.maxRounds;
const WATCH_STREAK_RETRY_COOLDOWN_MS = POLICY.retryCooldownMs;
const ROUND_CHECKS = POLICY.unhealthyChecksPerRound;

function credit(
  streaks: WatchStreakState,
  observation: Parameters<typeof recordWatchStreakCredit>[1],
): ReturnType<typeof recordWatchStreakCredit> {
  return recordWatchStreakCredit(streaks, observation, POLICY);
}
const T0 = Date.parse("2026-10-24T12:00:00.000Z");

// Merging prunes attempts against the real clock (WATCH_STREAK_RETENTION_MS),
// so every test runs at T0: without that, the fixtures age out of the
// retention window a week after T0 and the merge tests start failing.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

function channel(username: string, broadcastId = `b-${username}`): ChannelCandidate {
  return {
    platform: "twitch",
    username,
    url: `https://www.twitch.tv/${username}`,
    channelId: `c${username.length}${username.charCodeAt(0)}`,
    broadcastId,
    live: true,
  };
}

function watching(candidate: ChannelCandidate): WatchSession {
  return {
    ...structuredClone(DEFAULT_STATE.sessions.twitch),
    status: "watching",
    channel: candidate,
  };
}

function accrue(
  streaks: WatchStreakState,
  session: WatchSession,
  now: number,
  overrides: Partial<Parameters<typeof accrueWatchStreak>[1]> = {},
): WatchStreakState {
  return accrueWatchStreak(streaks, {
    session,
    accountId: ACCOUNT,
    maintained: new Set([session.channel?.username ?? ""]),
    healthy: true,
    paused: false,
    now,
    policy: POLICY,
    ...overrides,
  });
}

function withWatchlist(channels: string[], streaks: string[]): ExtensionSettings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  return applySettingsPatch(settings, {
    platform: {
      twitch: { watchlistChannels: channels, watchlistStreakChannels: streaks },
    },
  });
}

describe("watch-streak attempts", () => {
  it("counts only healthy watching it observed, capped per step", () => {
    const session = watching(channel("alpha"));
    let streaks: WatchStreakState = { attempts: [] };
    streaks = accrue(streaks, session, T0);
    expect(streaks.attempts[0]).toMatchObject({ outcome: "pending", watchedMs: 0 });
    streaks = accrue(streaks, session, T0 + 60_000);
    expect(streaks.attempts[0]!.watchedMs).toBe(60_000);
    // An hour-long suspension adds one step at most.
    streaks = accrue(streaks, session, T0 + 3_660_000);
    expect(streaks.attempts[0]!.watchedMs).toBe(60_000 + POLICY.maxAccrualStepMs);
  });

  it("does not count time across an unhealthy check, a switch away or a pause", () => {
    const alpha = watching(channel("alpha"));
    let streaks = accrue({ attempts: [] }, alpha, T0);
    streaks = accrue(streaks, alpha, T0 + 60_000, { healthy: false });
    streaks = accrue(streaks, alpha, T0 + 120_000);
    expect(streaks.attempts[0]).toMatchObject({ watchedMs: 0, unhealthyChecks: 1 });
    streaks = accrue(streaks, watching(channel("other")), T0 + 180_000, {
      maintained: new Set(["alpha"]),
    });
    expect(streaks.observing).toBeUndefined();
    streaks = accrue(streaks, alpha, T0 + 240_000, { paused: true });
    streaks = accrue(streaks, alpha, T0 + 300_000);
    expect(streaks.attempts[0]!.watchedMs).toBe(0);
    streaks = accrue(streaks, alpha, T0 + 360_000);
    expect(streaks.attempts[0]!.watchedMs).toBe(60_000);
  });

  it("ends the attempt as not confirmed when the budget runs out, and never reopens it", () => {
    const session = watching(channel("alpha"));
    let streaks: WatchStreakState = { attempts: [] };
    let now = T0;
    for (let minute = 0; minute <= WATCH_STREAK_BUDGET_MS / 60_000; minute += 1) {
      streaks = accrue(streaks, session, now);
      now += 60_000;
    }
    expect(streaks.attempts).toHaveLength(1);
    expect(streaks.attempts[0]).toMatchObject({
      outcome: "not_confirmed",
      watchedMs: WATCH_STREAK_BUDGET_MS,
    });
    const after = accrue(streaks, session, now + 60_000);
    expect(after.attempts).toEqual(streaks.attempts);
  });

  // #942: a round that never played is not a watched streak. It rests, and
  // only running out of rounds ends it, as playback_failed.
  it("rests an attempt whose round never plays, then ends it as playback_failed", () => {
    const session = watching(channel("alpha"));
    let streaks: WatchStreakState = { attempts: [] };
    let now = T0;
    const unhealthyRound = () => {
      for (let check = 0; check < ROUND_CHECKS; check += 1) {
        streaks = accrue(streaks, session, now, { healthy: false });
        now += 60_000;
      }
    };
    unhealthyRound();
    const rested = streaks.attempts[0]!;
    expect(rested).toMatchObject({ outcome: "pending", watchedMs: 0 });
    expect(Date.parse(rested.retryAt!)).toBe(now - 60_000 + WATCH_STREAK_RETRY_COOLDOWN_MS);
    const state = structuredClone(DEFAULT_STATE);
    state.authHealth.twitch = { status: "healthy", accountId: ACCOUNT };
    state.watchStreaks = { twitch: streaks };
    const plan = (at: number) =>
      watchStreakPlan("twitch", withWatchlist(["alpha"], ["alpha"]), state, true, at);
    expect(plan(now).verdict(channel("alpha"))).toBe("cooling");
    expect(plan(Date.parse(rested.retryAt!)).verdict(channel("alpha"))).toBe("pending");

    // Watched as an ordinary row while resting: unhealthy checks do not count.
    for (let minute = 0; minute < 5; minute += 1) {
      streaks = accrue(streaks, session, now, { healthy: false });
      now += 60_000;
    }
    expect(streaks.attempts[0]).toMatchObject({ unhealthyChecks: 0, failedRounds: 1 });

    for (let round = 1; round < WATCH_STREAK_MAX_ROUNDS; round += 1) {
      now = Date.parse(streaks.attempts[0]!.retryAt!);
      expect(streaks.attempts[0]!.outcome).toBe("pending");
      unhealthyRound();
    }
    expect(streaks.attempts).toHaveLength(1);
    expect(streaks.attempts[0]).toMatchObject({
      outcome: "playback_failed",
      watchedMs: 0,
      unhealthyChecks: 0,
      failedRounds: WATCH_STREAK_MAX_ROUNDS,
    });
    const after = accrue(streaks, session, now + WATCH_STREAK_RETRY_COOLDOWN_MS);
    expect(after.attempts).toEqual(streaks.attempts);
  });

  it("keeps a resting attempt's watched time and finishes its budget in a later round", () => {
    const session = watching(channel("alpha"));
    let streaks: WatchStreakState = { attempts: [] };
    let now = T0;
    for (let minute = 0; minute <= 5; minute += 1) {
      streaks = accrue(streaks, session, now);
      now += 60_000;
    }
    for (let check = 0; check < ROUND_CHECKS; check += 1) {
      streaks = accrue(streaks, session, now, { healthy: false });
      now += 60_000;
    }
    expect(streaks.attempts[0]).toMatchObject({ outcome: "pending", watchedMs: 5 * 60_000 });
    now = Date.parse(streaks.attempts[0]!.retryAt!);
    while (streaks.attempts[0]!.outcome === "pending") {
      streaks = accrue(streaks, session, now);
      now += 60_000;
    }
    expect(streaks.attempts[0]).toMatchObject({
      outcome: "not_confirmed",
      watchedMs: WATCH_STREAK_BUDGET_MS,
    });
  });

  it("keeps a rest and the round count across merges and restores", () => {
    const session = watching(channel("alpha"));
    let resting: WatchStreakState = { attempts: [] };
    for (let check = 0; check < ROUND_CHECKS; check += 1)
      resting = accrue(resting, session, T0 + check * 60_000, { healthy: false });
    const stale = accrue({ attempts: [] }, session, T0, { healthy: false });
    const merged = mergeWatchStreakState(resting, stale)!;
    expect(merged.attempts[0]).toMatchObject({
      unhealthyChecks: 0,
      failedRounds: 1,
      retryAt: resting.attempts[0]!.retryAt,
    });
    const restored = normalizeWatchStreakState(JSON.parse(JSON.stringify(merged)))!;
    expect(restored.attempts[0]!.retryAt).toBe(resting.attempts[0]!.retryAt);
  });

  it("neither accrues nor counts a failure while a new watch is settling", () => {
    const session = watching(channel("alpha"));
    let streaks = accrue({ attempts: [] }, session, T0, { healthy: false, settling: true });
    streaks = accrue(streaks, session, T0 + 60_000, { healthy: false, settling: true });
    expect(streaks.attempts[0]).toMatchObject({ watchedMs: 0, unhealthyChecks: 0 });
  });

  it("keys attempts by account, channel and broadcast", () => {
    const first = watching(channel("alpha", "b1"));
    let streaks = accrue({ attempts: [] }, first, T0);
    streaks = accrue(streaks, watching(channel("alpha", "b2")), T0 + 60_000);
    streaks = accrue(streaks, watching(channel("alpha", "b2")), T0 + 120_000, {
      accountId: "2000",
    });
    expect(streaks.attempts.map((attempt) => [attempt.accountId, attempt.broadcastId])).toEqual([
      [ACCOUNT, "b1"],
      [ACCOUNT, "b2"],
      ["2000", "b2"],
    ]);
  });

  it("skips a watch it cannot attribute", () => {
    const missing = watching({ ...channel("alpha"), broadcastId: undefined });
    expect(accrue({ attempts: [] }, missing, T0).attempts).toEqual([]);
    expect(
      accrue({ attempts: [] }, watching(channel("alpha")), T0, { accountId: undefined }).attempts,
    ).toEqual([]);
  });
});

describe("watch-streak cadence", () => {
  it("keeps the one-minute limits at the default poll interval", () => {
    expect(POLICY).toMatchObject({
      maxAccrualStepMs: 2 * 60_000,
      creditLagMs: 10 * 60_000,
      unhealthyChecksPerRound: 10,
    });
  });

  it("widens the step and the payout window with the poll interval", () => {
    expect(policyAt(5)).toMatchObject({
      maxAccrualStepMs: 6 * 60_000,
      creditLagMs: 10 * 60_000,
      unhealthyChecksPerRound: 2,
    });
    expect(policyAt(60)).toMatchObject({
      maxAccrualStepMs: 61 * 60_000,
      creditLagMs: 65 * 60_000,
      unhealthyChecksPerRound: 2,
    });
  });

  it("still never counts a gap longer than one poll interval", () => {
    const policy = policyAt(5);
    const session = watching(channel("alpha"));
    let streaks = accrue({ attempts: [] }, session, T0, { policy });
    streaks = accrue(streaks, session, T0 + 3 * 3_600_000, { policy });
    expect(streaks.attempts[0]!.watchedMs).toBe(policy.maxAccrualStepMs);
  });

  it("credits a payout that arrived between two hourly ticks", () => {
    const session = watching(channel("alpha"));
    const started = accrue({ attempts: [] }, session, T0);
    const payout = {
      accountId: ACCOUNT,
      channelId: channel("alpha").channelId!,
      at: T0 + 40 * 60_000,
    };
    expect(credit(started, payout)).toBeUndefined();
    const hourly = recordWatchStreakCredit(started, payout, policyAt(60));
    expect(hourly?.attempt.outcome).toBe("credited");
  });

  it("never moves a round already counted when the poll interval changes", () => {
    const session = watching(channel("alpha"));
    let streaks: WatchStreakState = { attempts: [] };
    for (let check = 0; check < 7; check += 1)
      streaks = accrue(streaks, session, T0 + check * 60_000, { healthy: false });
    expect(streaks.attempts[0]).toMatchObject({ unhealthyChecks: 7, failedRounds: 0 });
    // A five-minute interval tolerates two checks: the current round ends,
    // and only that one.
    streaks = accrue(streaks, session, T0 + 8 * 60_000, {
      healthy: false,
      policy: policyAt(5),
    });
    expect(streaks.attempts[0]).toMatchObject({
      outcome: "pending",
      unhealthyChecks: 0,
      failedRounds: 1,
    });
  });

  it("splits a stored cumulative count into rounds", () => {
    const attempt = (unhealthyChecks: number, extra: Record<string, unknown> = {}) => ({
      accountId: ACCOUNT,
      channelId: "1",
      broadcastId: "2",
      username: "alpha",
      outcome: "pending",
      watchedMs: 0,
      unhealthyChecks,
      startedAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
      ...extra,
    });
    const restored = normalizeWatchStreakState({
      attempts: [
        attempt(13),
        attempt(30, { broadcastId: "3" }),
        attempt(4, { broadcastId: "4", failedRounds: 2 }),
      ],
    })!;
    expect(
      restored.attempts.map(({ failedRounds, unhealthyChecks }) => [failedRounds, unhealthyChecks]),
    ).toEqual([
      [1, 3],
      [3, 0],
      [2, 4],
    ]);
  });

  it("keeps the further round when merging copies from two rounds", () => {
    const session = watching(channel("alpha"));
    let earlier: WatchStreakState = { attempts: [] };
    for (let check = 0; check < ROUND_CHECKS - 1; check += 1)
      earlier = accrue(earlier, session, T0 + check * 60_000, { healthy: false });
    const later = accrue(earlier, session, T0 + ROUND_CHECKS * 60_000, { healthy: false });
    expect(later.attempts[0]).toMatchObject({ failedRounds: 1, unhealthyChecks: 0 });
    for (const merged of [
      mergeWatchStreakState(earlier, later),
      mergeWatchStreakState(later, earlier),
    ])
      expect(merged!.attempts[0]).toMatchObject({ failedRounds: 1, unhealthyChecks: 0 });
  });
});

describe("watch-streak tuning", () => {
  it("defaults, clamps and rounds the tuning on every host", () => {
    expect(DEFAULT_SETTINGS.platform.twitch).toMatchObject({
      watchStreakBudgetMinutes: 15,
      watchStreakRetryCooldownMinutes: 30,
      watchStreakMaxRounds: 3,
    });
    const merged = mergeSettings({
      platform: {
        twitch: {
          watchStreakBudgetMinutes: 1_000,
          watchStreakRetryCooldownMinutes: 0,
          watchStreakMaxRounds: 2.6,
        },
      },
    } as never);
    expect(merged.platform.twitch).toMatchObject({
      watchStreakBudgetMinutes: 60,
      watchStreakRetryCooldownMinutes: 10,
      watchStreakMaxRounds: 3,
    });
    const garbage = mergeSettings({
      platform: { twitch: { watchStreakBudgetMinutes: "soon", watchStreakMaxRounds: Number.NaN } },
    } as never);
    expect(garbage.platform.twitch).toMatchObject({
      watchStreakBudgetMinutes: 15,
      watchStreakMaxRounds: 3,
    });
  });

  it("builds the policy from the tuning", () => {
    expect(
      policyAt(1, {
        watchStreakBudgetMinutes: 20,
        watchStreakRetryCooldownMinutes: 45,
        watchStreakMaxRounds: 5,
      }),
    ).toMatchObject({ budgetMs: 20 * 60_000, retryCooldownMs: 45 * 60_000, maxRounds: 5 });
  });

  it("ends a running attempt at a lowered budget and never reopens one at a raised budget", () => {
    const session = watching(channel("alpha"));
    let streaks: WatchStreakState = { attempts: [] };
    for (let minute = 0; minute <= 8; minute += 1)
      streaks = accrue(streaks, session, T0 + minute * 60_000);
    expect(streaks.attempts[0]).toMatchObject({ outcome: "pending", watchedMs: 8 * 60_000 });
    const lowered = policyAt(1, { watchStreakBudgetMinutes: 5 });
    streaks = accrue(streaks, session, T0 + 9 * 60_000, { policy: lowered });
    expect(streaks.attempts[0]!.outcome).toBe("not_confirmed");
    const raised = policyAt(1, { watchStreakBudgetMinutes: 60 });
    const after = accrue(streaks, session, T0 + 10 * 60_000, { policy: raised });
    expect(after.attempts).toEqual(streaks.attempts);
  });

  it("ends an attempt that already used more rounds than a lowered cap at its next round", () => {
    const session = watching(channel("alpha"));
    let streaks: WatchStreakState = { attempts: [] };
    let now = T0;
    for (let round = 0; round < 2; round += 1) {
      for (let check = 0; check < ROUND_CHECKS; check += 1) {
        streaks = accrue(streaks, session, now, { healthy: false });
        now += 60_000;
      }
      now = Date.parse(streaks.attempts[0]!.retryAt!);
    }
    expect(streaks.attempts[0]).toMatchObject({ outcome: "pending", failedRounds: 2 });
    const one = policyAt(1, { watchStreakMaxRounds: 1 });
    // The round in progress still runs to its end; only then is the cap read.
    streaks = accrue(streaks, session, now, { healthy: false, policy: one });
    expect(streaks.attempts[0]!.outcome).toBe("pending");
    for (let check = 1; check < ROUND_CHECKS; check += 1) {
      now += 60_000;
      streaks = accrue(streaks, session, now, { healthy: false, policy: one });
    }
    expect(streaks.attempts[0]).toMatchObject({ outcome: "playback_failed", failedRounds: 3 });
  });
});

describe("watch-streak payouts", () => {
  const alpha = channel("alpha");
  const started = accrue({ attempts: [] }, watching(alpha), T0);

  it("credits the account's running attempt on that channel", () => {
    const result = credit(started, {
      accountId: ACCOUNT,
      channelId: alpha.channelId!,
      at: T0 + 120_000,
    });
    expect(result?.attempt).toMatchObject({ outcome: "credited", broadcastId: alpha.broadcastId });
  });

  it("ignores another account, another channel, a duplicate and a stale payout", () => {
    expect(
      credit(started, { accountId: "2000", channelId: alpha.channelId!, at: T0 }),
    ).toBeUndefined();
    expect(credit(started, { accountId: ACCOUNT, channelId: "999", at: T0 })).toBeUndefined();
    const credited = credit(started, {
      accountId: ACCOUNT,
      channelId: alpha.channelId!,
      at: T0,
    })!.state;
    expect(
      credit(credited, {
        accountId: ACCOUNT,
        channelId: alpha.channelId!,
        at: T0 + 1,
      }),
    ).toBeUndefined();
    // Hours after the attempt was last observed: a later broadcast's payout.
    expect(
      credit(started, {
        accountId: ACCOUNT,
        channelId: alpha.channelId!,
        at: T0 + 3 * 3_600_000,
      }),
    ).toBeUndefined();
    // Long before the attempt started: a previous broadcast's payout.
    expect(
      credit(started, {
        accountId: ACCOUNT,
        channelId: alpha.channelId!,
        at: T0 - 3 * 3_600_000,
      }),
    ).toBeUndefined();
  });

  it("upgrades an attempt whose budget just ran out", () => {
    const exhausted: WatchStreakState = {
      attempts: [
        {
          ...started.attempts[0]!,
          outcome: "not_confirmed",
          watchedMs: WATCH_STREAK_BUDGET_MS,
          completedAt: new Date(T0 + WATCH_STREAK_BUDGET_MS).toISOString(),
        },
      ],
    };
    const result = credit(exhausted, {
      accountId: ACCOUNT,
      channelId: alpha.channelId!,
      at: T0 + WATCH_STREAK_BUDGET_MS + 30_000,
    });
    expect(result?.attempt.outcome).toBe("credited");
  });

  it("survives a tick that committed an older copy of the attempt", () => {
    const credited = credit(started, {
      accountId: ACCOUNT,
      channelId: alpha.channelId!,
      at: T0 + 60_000,
    })!.state;
    const tickCopy = accrue(started, watching(alpha), T0 + 120_000);
    const merged = mergeWatchStreakState(credited, tickCopy)!;
    expect(merged.attempts).toHaveLength(1);
    expect(merged.attempts[0]).toMatchObject({
      outcome: "credited",
      watchedMs: POLICY.maxAccrualStepMs,
    });
    expect(merged.observing).toBeUndefined();

    const stored = { ...structuredClone(DEFAULT_STATE), watchStreaks: { twitch: credited } };
    const tickState = { ...structuredClone(DEFAULT_STATE), watchStreaks: { twitch: tickCopy } };
    expect(
      mergePlatformState(stored, tickState, "twitch").watchStreaks?.twitch?.attempts[0]?.outcome,
    ).toBe("credited");
  });

  it("does not restore an attempt the tick pruned", () => {
    const stale = {
      ...started.attempts[0]!,
      broadcastId: "old-broadcast",
      startedAt: new Date(Date.now() - WATCH_STREAK_RETENTION_MS - 120_000).toISOString(),
      updatedAt: new Date(Date.now() - WATCH_STREAK_RETENTION_MS - 60_000).toISOString(),
    };
    const stored: WatchStreakState = { attempts: [stale] };
    const tick = pruneWatchStreaks(stored, Date.now());
    expect(tick.attempts).toEqual([]);
    expect(mergeWatchStreakState(stored, tick)?.attempts).toEqual([]);
  });
});

describe("watch-streak storage", () => {
  it("prunes old and excess attempts", () => {
    const template = accrue({ attempts: [] }, watching(channel("alpha")), T0).attempts[0]!;
    const attempts = Array.from({ length: WATCH_STREAK_MAX_ATTEMPTS + 5 }, (_, index) => ({
      ...template,
      broadcastId: `b${index}`,
    }));
    attempts[0] = {
      ...attempts[0]!,
      updatedAt: new Date(T0 - WATCH_STREAK_RETENTION_MS - 1).toISOString(),
    };
    const pruned = pruneWatchStreaks({ attempts }, T0);
    expect(pruned.attempts).toHaveLength(WATCH_STREAK_MAX_ATTEMPTS);
    expect(pruned.attempts.some((attempt) => attempt.broadcastId === "b0")).toBe(false);
  });

  it("restores valid records and drops malformed ones", () => {
    const valid = accrue({ attempts: [] }, watching(channel("alpha")), T0);
    const restored = mergeSchedulerState({
      watchStreaks: {
        twitch: {
          ...valid,
          attempts: [...valid.attempts, { accountId: "x y", channelId: 1 } as never],
          rows: { alpha: "watching", beta: "nonsense" as never },
        },
      },
    } as Partial<SchedulerState>);
    expect(restored.watchStreaks?.twitch?.attempts).toEqual(valid.attempts);
    expect(restored.watchStreaks?.twitch?.rows).toEqual({ alpha: "watching" });
    expect(normalizeWatchStreakState("garbage")).toBeUndefined();
  });

  it("keeps the account id only on healthy auth", () => {
    const restored = mergeSchedulerState({
      authHealth: {
        twitch: { status: "healthy", accountId: "1000" },
        kick: { status: "unavailable", accountId: "1000" } as never,
      },
    } as Partial<SchedulerState>);
    expect(restored.authHealth.twitch.accountId).toBe("1000");
    expect(restored.authHealth.kick.accountId).toBeUndefined();
  });
});

describe("watch-streak settings", () => {
  it("defaults to none and only keeps channels on the watchlist", () => {
    expect(mergeSettings({}).platform.twitch.watchlistStreakChannels).toEqual([]);
    const settings = withWatchlist(["a", "b", "c"], ["C", "ghost", "a"]);
    expect(settings.platform.twitch.watchlistStreakChannels).toEqual(["a", "c"]);
  });

  it("keeps opt-ins across a reorder and clears them on removal", () => {
    const settings = withWatchlist(["a", "b", "c"], ["a", "c"]);
    const reordered = applySettingsPatch(settings, {
      platform: { twitch: { watchlistChannels: ["c", "b", "a"] } },
    });
    expect(reordered.platform.twitch.watchlistStreakChannels).toEqual(["c", "a"]);
    const removed = applySettingsPatch(reordered, {
      platform: { twitch: { watchlistChannels: ["b", "a"] } },
    });
    expect(removed.platform.twitch.watchlistStreakChannels).toEqual(["a"]);
  });

  it("round-trips through export and import, and resets to none", () => {
    const settings = withWatchlist(["a", "b"], ["b"]);
    const imported = parseSettingsImportPayload(
      JSON.parse(JSON.stringify(buildSettingsExportPayload(settings))),
    );
    expect(imported.settings.platform.twitch.watchlistStreakChannels).toEqual(["b"]);
    expect(DEFAULT_SETTINGS.platform.twitch.watchlistStreakChannels).toEqual([]);
  });

  it("orders maintained rows first, each group in the user's order", () => {
    expect(orderIdleWatchlist(["a", "b", "c", "d"], ["d", "b"])).toEqual(["b", "d", "a", "c"]);
  });

  it("reads every row as unavailable without an observer or an account", () => {
    const settings = withWatchlist(["a"], ["a"]);
    const state = structuredClone(DEFAULT_STATE);
    state.authHealth.twitch = { status: "healthy", accountId: ACCOUNT };
    expect(watchStreakPlan("twitch", settings, state, false).verdict(channel("a"))).toBe(
      "unavailable",
    );
    state.authHealth.twitch = { status: "healthy" };
    expect(watchStreakPlan("twitch", settings, state, true).verdict(channel("a"))).toBe(
      "unavailable",
    );
    expect(watchStreakPlan("kick", settings, state, true).maintained).toEqual([]);
  });
});

describe("watch-streak scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(
    options: {
      channels?: string[];
      streaks?: string[];
      observer?: boolean;
      live?: string[];
      // A live drop campaign farmable on "dropper".
      drop?: boolean;
      order?: WatchSourceId[];
      // Restore the state from storage every N ticks, as an MV3 restart does.
      restartEvery?: number;
      // Minutes between ticks (pollIntervalMinutes).
      pollMinutes?: number;
    } = {},
  ) {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.platform.twitch.enabled = true;
    settings.platform.twitch.watchSourcePriority = options.order ?? [
      "drops",
      "nopixel",
      "fortnite",
      "watchlist",
    ];
    const campaign: DropCampaign = {
      id: "drop",
      platform: "twitch",
      name: "Drop",
      categoryId: "game",
      gameName: "Game",
      status: "active",
      startsAt: new Date(T0 - 3_600_000).toISOString(),
      endsAt: new Date(T0 + 7 * 86_400_000).toISOString(),
      accountLinked: true,
      eligibility: "eligible",
      priority: 1,
      rewards: [
        {
          id: "reward",
          name: "Reward",
          requiredMinutes: 6000,
          watchedMinutes: 10,
          status: "in_progress",
        },
      ],
    };
    const patched = applySettingsPatch(settings, {
      platform: {
        twitch: {
          watchlistChannels: options.channels ?? ["ordinary", "streaky"],
          watchlistStreakChannels: options.streaks ?? ["streaky"],
        },
      },
    });
    patched.pollIntervalMinutes = options.pollMinutes ?? 1;
    let state: SchedulerState = structuredClone(DEFAULT_STATE);
    state.authHealth.twitch = { status: "healthy", accountId: ACCOUNT };
    const broadcasts = new Map<string, string>();
    const live = new Set(options.live ?? patched.platform.twitch.watchlistChannels);
    const adapter: SchedulerTestAdapter = {
      platform: "twitch",
      supportsTabless: true,
      checkAuthHealth: async () => ({ status: "healthy", accountId: ACCOUNT }),
      refreshCampaigns: async () => (options.drop ? [structuredClone(campaign)] : []),
      listCandidateChannels: async () =>
        options.drop ? [{ ...channel("dropper"), isAclMatch: true }] : [],
      checkChannel: async (candidate) => {
        const username = candidate.username.toLowerCase();
        const isLive = live.has(username) || (options.drop === true && username === "dropper");
        return {
          live: isLive,
          categoryMatches: isLive,
          candidate: isLive
            ? {
                ...channel(username, broadcasts.get(username) ?? `b-${username}`),
                url: candidate.url,
              }
            : candidate,
        };
      },
      claimReward: async () => true,
      prepareWatchTab: vi.fn(async () => ({ tabId: 1, managedByExtension: true })),
      stopWatchTab: vi.fn(async () => {}),
      ...(options.observer === false
        ? {}
        : { createChannelPointsPushController: (() => ({})) as never }),
    };
    const adapters = { twitch: adapter, kick: { ...adapter, platform: "kick" as const } };
    const watched: string[] = [];
    let ticks = 0;
    // One tick per poll interval. `healthy` stands for the heartbeat the
    // controller would have recorded since the last tick.
    async function tick(healthy = true, tickOptions: SchedulerTickTestOptions = {}) {
      ticks += 1;
      if (options.restartEvery && ticks % options.restartEvery === 0)
        state = mergeSchedulerState(JSON.parse(JSON.stringify(state)));
      if (state.sessions.twitch.status === "watching") {
        state.sessions.twitch.lastHeartbeatOk = healthy;
        state.sessions.twitch.lastHeartbeatAt = new Date().toISOString();
      }
      const result = await runSchedulerTick(state, patched, adapters, {
        platforms: ["twitch"],
        ...tickOptions,
      });
      state = result.state;
      const session = state.sessions.twitch;
      watched.push(session.status === "watching" ? session.channel!.username : "-");
      vi.setSystemTime(Date.now() + patched.pollIntervalMinutes * 60_000);
      return result;
    }
    return {
      settings: patched,
      get state() {
        return state;
      },
      set state(next: SchedulerState) {
        state = next;
      },
      live,
      broadcasts,
      watched,
      tick,
    };
  }

  it("watches a maintained row ahead of an always-live ordinary row, then moves on", async () => {
    const s = setup({ restartEvery: 4 });
    await s.tick();
    expect(s.state.sessions.twitch.channel?.username).toBe("streaky");
    expect(s.state.watchStreaks?.twitch?.rows).toEqual({ streaky: "watching" });
    for (let minute = 0; minute < 20; minute += 1) await s.tick();
    expect(s.state.sessions.twitch.channel?.username).toBe("ordinary");
    expect(s.state.watchStreaks?.twitch?.rows).toEqual({ streaky: "not_confirmed" });
    expect(s.state.watchStreaks?.twitch?.attempts[0]).toMatchObject({
      outcome: "not_confirmed",
      watchedMs: WATCH_STREAK_BUDGET_MS,
    });
  });

  it("advances through several maintained rows in order and skips offline ones", async () => {
    const s = setup({
      channels: ["ordinary", "first", "offline", "second"],
      streaks: ["first", "offline", "second"],
      live: ["ordinary", "first", "second"],
    });
    for (let minute = 0; minute < 40; minute += 1) await s.tick();
    const order = s.watched.filter((name, index) => name !== s.watched[index - 1]);
    expect(order).toEqual(["first", "second", "ordinary"]);
  });

  // A finished row is an ordinary Watchlist row again, so when it is the only
  // live one it keeps being watched: one open, no switching away and back.
  it("keeps watching a finished maintained row as an ordinary row for hours", async () => {
    const s = setup({ channels: ["streaky"], streaks: ["streaky"], restartEvery: 7 });
    let opens = 0;
    for (let minute = 0; minute < 6 * 60; minute += 1) {
      const before = s.state.sessions.twitch.status;
      await s.tick();
      if (before !== "watching" && s.state.sessions.twitch.status === "watching") opens += 1;
    }
    expect(s.state.watchStreaks?.twitch?.attempts).toHaveLength(1);
    expect(s.state.watchStreaks?.twitch?.attempts[0]?.outcome).toBe("not_confirmed");
    expect(new Set(s.watched)).toEqual(new Set(["streaky"]));
    expect(opens).toBe(1);
  });

  it("stops reopening a maintained row that never plays, across hours and restarts", async () => {
    const s = setup({ channels: ["streaky"], streaks: ["streaky"], restartEvery: 7 });
    s.settings.tablessMode = false;
    const adapter = { opens: 0 };
    for (let minute = 0; minute < 6 * 60; minute += 1) {
      const before = s.state.sessions.twitch.status;
      await s.tick(false);
      if (before !== "watching" && s.state.sessions.twitch.status === "watching")
        adapter.opens += 1;
    }
    // After the attempt ends it is watched like an ordinary row that never
    // plays: kept, not reopened.
    const lastHour = s.watched.slice(-60);
    expect(lastHour.every((name) => name === "streaky")).toBe(true);
    expect(s.state.watchStreaks?.twitch?.attempts).toHaveLength(1);
    expect(s.state.watchStreaks?.twitch?.attempts[0]?.outcome).toBe("playback_failed");
    expect(s.state.watchStreaks?.twitch?.rows).toEqual({ streaky: "playback_failed" });
    expect(adapter.opens).toBeLessThanOrEqual(ROUND_CHECKS);
  });

  // #942: playback that fails for a while must not spend the row's streak.
  it("moves on from a row that never plays, then retries it after the rest", async () => {
    const s = setup({
      channels: ["broken", "working"],
      streaks: ["broken", "working"],
      live: ["broken", "working"],
      restartEvery: 5,
    });
    let brokenPlays = false;
    const tick = () =>
      s.tick(brokenPlays || s.state.sessions.twitch.channel?.username !== "broken");
    for (let minute = 0; minute < 15; minute += 1) await tick();
    expect(s.state.watchStreaks?.twitch?.rows?.broken).toBe("pending");
    expect(s.state.sessions.twitch.channel?.username).toBe("working");

    brokenPlays = true;
    for (let minute = 0; minute < WATCH_STREAK_RETRY_COOLDOWN_MS / 60_000 + 20; minute += 1)
      await tick();
    const broken = s.state.watchStreaks?.twitch?.attempts.find(
      (attempt) => attempt.username === "broken",
    );
    expect(broken).toMatchObject({ outcome: "not_confirmed", watchedMs: WATCH_STREAK_BUDGET_MS });
    const order = s.watched.filter((name, index) => name !== s.watched[index - 1]);
    expect(order.slice(0, 3)).toEqual(["broken", "working", "broken"]);
  });

  // #942: while a row that never plays rests, something else is live and wins.
  // Each round leaves and comes back, so the round cap is what ends the opens.
  it("ends the returns to a row that never plays while another row is live, across hours", async () => {
    const s = setup({ channels: ["ordinary", "streaky"], streaks: ["streaky"], restartEvery: 7 });
    const retries: string[] = [];
    const emit: EventEmitter = (event) => {
      if (event.category === "diagnostic" && event.message.includes("stopped playing"))
        retries.push(event.message);
    };
    for (let minute = 0; minute < 6 * 60; minute += 1)
      await s.tick(s.state.sessions.twitch.channel?.username !== "streaky", { emit });
    const entries = s.watched.filter(
      (name, index) => name === "streaky" && s.watched[index - 1] !== "streaky",
    );
    expect(entries).toHaveLength(WATCH_STREAK_MAX_ROUNDS);
    expect(s.watched.slice(-60).every((name) => name === "ordinary")).toBe(true);
    expect(s.state.watchStreaks?.twitch?.attempts[0]?.outcome).toBe("playback_failed");
    expect(s.state.watchStreaks?.twitch?.rows).toEqual({ streaky: "playback_failed" });
    // One rest note per round that rested, not one per tick.
    expect(retries).toHaveLength(WATCH_STREAK_MAX_ROUNDS - 1);
  });

  // Ticks run at the poll interval, so a healthy watch accrues a whole
  // interval per tick, not the one-minute default's two-minute cap.
  it("spends the budget in about its own time at a five-minute poll interval", async () => {
    const s = setup({ channels: ["streaky"], streaks: ["streaky"], pollMinutes: 5 });
    // One tick selects the row and the next starts observing it.
    const ticks = WATCH_STREAK_BUDGET_MS / (5 * 60_000) + 2;
    for (let tick = 0; tick < ticks; tick += 1) await s.tick();
    expect(s.state.watchStreaks?.twitch?.attempts[0]).toMatchObject({
      outcome: "not_confirmed",
      watchedMs: WATCH_STREAK_BUDGET_MS,
    });
  });

  // A payout can arrive before the next tick observes the watch, up to a whole
  // poll interval after the row was chosen. It must land on this broadcast's
  // attempt, never be dropped or credited to an earlier broadcast's.
  it("credits a payout that arrives before the first observation", async () => {
    const s = setup({ channels: ["streaky"], streaks: ["streaky"], pollMinutes: 60 });
    s.broadcasts.set("streaky", "first");
    await s.tick();
    await s.tick();
    s.broadcasts.set("streaky", "second");
    s.live.delete("streaky");
    await s.tick();
    s.live.add("streaky");
    await s.tick();
    expect(s.state.sessions.twitch.channel?.broadcastId).toBe("second");
    const credited = recordWatchStreakCredit(
      s.state.watchStreaks!.twitch!,
      {
        accountId: ACCOUNT,
        channelId: channel("streaky").channelId!,
        at: Date.now() - 55 * 60_000,
      },
      policyAt(60),
    );
    expect(credited?.attempt).toMatchObject({ broadcastId: "second", outcome: "credited" });
  });

  it("ends the returns to a row that never plays at an hourly poll interval", async () => {
    const s = setup({
      channels: ["ordinary", "streaky"],
      streaks: ["streaky"],
      restartEvery: 7,
      pollMinutes: 60,
    });
    for (let hour = 0; hour < 3 * 24; hour += 1)
      await s.tick(s.state.sessions.twitch.channel?.username !== "streaky");
    const entries = s.watched.filter(
      (name, index) => name === "streaky" && s.watched[index - 1] !== "streaky",
    );
    expect(entries).toHaveLength(WATCH_STREAK_MAX_ROUNDS);
    expect(s.watched.slice(-24).every((name) => name === "ordinary")).toBe(true);
    expect(s.state.watchStreaks?.twitch?.attempts[0]?.outcome).toBe("playback_failed");
  });

  // The round cap and the rest are user settings, so the opens must still end
  // at both ends of their ranges.
  for (const [rounds, cooldownMinutes] of [
    [
      WATCH_STREAK_TUNING_BOUNDS.watchStreakMaxRounds.max,
      WATCH_STREAK_TUNING_BOUNDS.watchStreakRetryCooldownMinutes.min,
    ],
    [
      WATCH_STREAK_TUNING_BOUNDS.watchStreakMaxRounds.min,
      WATCH_STREAK_TUNING_BOUNDS.watchStreakRetryCooldownMinutes.max,
    ],
  ] as const) {
    it(`ends the returns to a row that never plays with ${rounds} rounds and a ${cooldownMinutes}-minute rest`, async () => {
      const s = setup({ channels: ["ordinary", "streaky"], streaks: ["streaky"], restartEvery: 7 });
      s.settings.platform.twitch.watchStreakMaxRounds = rounds;
      s.settings.platform.twitch.watchStreakRetryCooldownMinutes = cooldownMinutes;
      for (let minute = 0; minute < 12 * 60; minute += 1)
        await s.tick(s.state.sessions.twitch.channel?.username !== "streaky");
      const entries = s.watched.filter(
        (name, index) => name === "streaky" && s.watched[index - 1] !== "streaky",
      );
      expect(entries).toHaveLength(rounds);
      expect(s.watched.slice(-60).every((name) => name === "ordinary")).toBe(true);
      expect(s.state.watchStreaks?.twitch?.attempts[0]?.outcome).toBe("playback_failed");
    });
  }

  it("spends the budget the user set", async () => {
    const s = setup({ channels: ["streaky"], streaks: ["streaky"] });
    s.settings.platform.twitch.watchStreakBudgetMinutes = 5;
    for (let minute = 0; minute < 8; minute += 1) await s.tick();
    expect(s.state.watchStreaks?.twitch?.attempts[0]).toMatchObject({
      outcome: "not_confirmed",
      watchedMs: 5 * 60_000,
    });
  });

  it("starts a fresh attempt for a new broadcast", async () => {
    const s = setup({ channels: ["streaky"], streaks: ["streaky"] });
    for (let minute = 0; minute < 20; minute += 1) await s.tick();
    expect(s.state.watchStreaks?.twitch?.attempts[0]?.outcome).toBe("not_confirmed");
    s.broadcasts.set("streaky", "b-next");
    // Opened by the tick that chooses the new broadcast, with nothing counted.
    await s.tick();
    expect(s.state.sessions.twitch.channel?.username).toBe("streaky");
    expect(s.state.watchStreaks?.twitch?.attempts.map((attempt) => attempt.broadcastId)).toEqual([
      "b-streaky",
      "b-next",
    ]);
    expect(s.state.watchStreaks?.twitch?.attempts[1]).toMatchObject({
      outcome: "pending",
      watchedMs: 0,
      unhealthyChecks: 0,
    });
    await s.tick();
    expect(s.state.watchStreaks?.twitch?.attempts).toHaveLength(2);
  });

  it("moves on as soon as a payout is recorded, even while retaining the watch", async () => {
    const s = setup();
    await s.tick();
    await s.tick();
    const attempt = s.state.watchStreaks!.twitch!.attempts[0]!;
    const credited = credit(s.state.watchStreaks!.twitch!, {
      accountId: ACCOUNT,
      channelId: attempt.channelId,
      at: Date.now(),
    })!;
    s.state = { ...s.state, watchStreaks: { twitch: credited.state } };
    await s.tick();
    expect(s.state.sessions.twitch.channel?.username).toBe("ordinary");
    expect(s.state.watchStreaks?.twitch?.rows).toEqual({ streaky: "credited" });
  });

  it("restores ordinary watching when the toggle is turned off", async () => {
    const s = setup({ channels: ["streaky"], streaks: ["streaky"] });
    for (let minute = 0; minute < 20; minute += 1) await s.tick();
    expect(s.state.watchStreaks?.twitch?.attempts[0]?.outcome).toBe("not_confirmed");
    s.settings.platform.twitch.watchlistStreakChannels = [];
    await s.tick();
    expect(s.state.sessions.twitch.channel?.username).toBe("streaky");
  });

  it("keeps maintained rows in their ordinary place on a host that cannot observe payouts", async () => {
    const s = setup({ observer: false });
    await s.tick();
    expect(s.state.sessions.twitch.channel?.username).toBe("ordinary");
    expect(s.state.watchStreaks?.twitch?.rows).toEqual({ streaky: "unavailable" });
    expect(s.state.watchStreaks?.twitch?.attempts ?? []).toEqual([]);

    const only = setup({ observer: false, live: ["streaky"] });
    for (let minute = 0; minute < 30; minute += 1) await only.tick();
    expect(only.state.sessions.twitch.channel?.username).toBe("streaky");
    expect(only.state.watchStreaks?.twitch?.attempts ?? []).toEqual([]);
  });

  it("watches a maintained row as an ordinary one without a known account", async () => {
    const s = setup({ channels: ["ordinary", "streaky"], live: ["streaky"] });
    s.state = {
      ...s.state,
      authHealth: { ...s.state.authHealth, twitch: { status: "healthy" } },
    };
    await s.tick();
    expect(s.state.sessions.twitch.channel?.username).toBe("streaky");
    expect(s.state.watchStreaks?.twitch?.rows).toEqual({ streaky: "unavailable" });
  });

  it("does not count ticks the platform skipped", async () => {
    const s = setup({ channels: ["streaky"], streaks: ["streaky"] });
    // Selects, starts the attempt, then counts the first observed minute.
    await s.tick();
    await s.tick();
    await s.tick();
    expect(s.state.watchStreaks?.twitch?.attempts[0]?.watchedMs).toBe(60_000);
    s.state = {
      ...s.state,
      authHealth: { ...s.state.authHealth, twitch: { status: "unavailable" } },
    };
    await s.tick();
    expect(s.state.watchStreaks?.twitch?.observing).toBeUndefined();
  });

  it("does not keep a finished row through a prepared selection", async () => {
    const s = setup();
    await s.tick();
    await s.tick();
    const attempt = s.state.watchStreaks!.twitch!.attempts[0]!;
    const credited = credit(s.state.watchStreaks!.twitch!, {
      accountId: ACCOUNT,
      channelId: attempt.channelId,
      at: Date.now(),
    })!;
    s.state = { ...s.state, watchStreaks: { twitch: credited.state } };
    const kept = s.state.sessions.twitch.channel!;
    await s.tick(true, {
      selections: {
        twitch: {
          decision: {
            platform: "twitch",
            action: "fallback",
            channel: kept,
            reason: "Keeping already committed snapshot selection",
            reasonCode: "keeping_current_watch",
          },
          retention: {
            keep: true,
            offlineChecks: 0,
            playbackChecks: 0,
            reason: "Keeping current watch tab",
            reasonCode: "keeping_current_watch",
            channel: kept,
          },
          campaignsChecked: 0,
          candidatesChecked: 0,
          fastPath: true,
        },
      },
    });
    expect(s.state.sessions.twitch.channel?.username).toBe("ordinary");
  });

  it("puts the whole Idle source, maintained rows first, ahead of Drops when ordered so", async () => {
    const s = setup({
      drop: true,
      order: ["watchlist", "drops", "nopixel", "fortnite"],
    });
    for (let minute = 0; minute < 25; minute += 1) await s.tick();
    const order = s.watched.filter((name, index) => name !== s.watched[index - 1]);
    expect(order).toEqual(["streaky", "ordinary"]);
  });

  // Ordered above Drops, the Watchlist keeps a finished row in its ordinary
  // place, as it would any live row; it does not hand over to Drops.
  it("keeps a finished maintained row in the Watchlist's place above Drops", async () => {
    const s = setup({
      drop: true,
      channels: ["streaky"],
      streaks: ["streaky"],
      order: ["watchlist", "drops", "nopixel", "fortnite"],
    });
    for (let minute = 0; minute < 25; minute += 1) await s.tick();
    expect(s.state.watchStreaks?.twitch?.attempts[0]?.outcome).toBe("not_confirmed");
    expect(new Set(s.watched)).toEqual(new Set(["streaky"]));
    expect(s.state.sessions.twitch.campaignId).toBeUndefined();
  });

  it("leaves maintenance opportunistic below a live drop", async () => {
    const s = setup({
      drop: true,
      order: ["drops", "nopixel", "fortnite", "watch_streaks", "watchlist"],
    });
    for (let minute = 0; minute < 25; minute += 1) await s.tick();
    expect(new Set(s.watched)).toEqual(new Set(["dropper"]));
    expect(s.state.watchStreaks?.twitch?.rows).toEqual({ streaky: "pending" });
  });

  it("puts only the streak rows ahead of Drops when Watch streaks is ordered there", async () => {
    const s = setup({
      drop: true,
      order: ["watch_streaks", "drops", "nopixel", "fortnite", "watchlist"],
    });
    for (let minute = 0; minute < 25; minute += 1) await s.tick();
    const order = s.watched.filter((name, index) => name !== s.watched[index - 1]);
    expect(order).toEqual(["streaky", "dropper"]);
    expect(s.state.watchStreaks?.twitch?.rows).toEqual({ streaky: "not_confirmed" });
  });

  it("interrupts a running drop for a streak ordered above Drops, then resumes it", async () => {
    const s = setup({
      drop: true,
      live: ["ordinary"],
      order: ["watch_streaks", "drops", "nopixel", "fortnite", "watchlist"],
    });
    await s.tick();
    expect(s.state.sessions.twitch.channel?.username).toBe("dropper");
    s.live.add("streaky");
    for (let minute = 0; minute < 25; minute += 1) await s.tick();
    const order = s.watched.filter((name, index) => name !== s.watched[index - 1]);
    expect(order).toEqual(["dropper", "streaky", "dropper"]);
  });

  it("keeps streak rows in their watchlist place when Watch streaks is ordered below it", async () => {
    const s = setup({
      channels: ["ordinary", "streaky"],
      order: ["drops", "nopixel", "fortnite", "watchlist", "watch_streaks"],
    });
    for (let minute = 0; minute < 5; minute += 1) await s.tick();
    expect(new Set(s.watched)).toEqual(new Set(["ordinary"]));
    // Reached in its ordinary place, the row still runs and ends its attempt.
    s.live.delete("ordinary");
    for (let minute = 0; minute < 25; minute += 1) await s.tick();
    expect(s.state.watchStreaks?.twitch?.attempts[0]).toMatchObject({
      username: "streaky",
      outcome: "not_confirmed",
    });
    expect(s.state.sessions.twitch.channel?.username).toBe("streaky");
  });

  it("watches streaks ahead of Drops by default", async () => {
    const s = setup({
      drop: true,
      order: [...DEFAULT_SETTINGS.platform.twitch.watchSourcePriority],
    });
    for (let minute = 0; minute < 25; minute += 1) await s.tick();
    const order = s.watched.filter((name, index) => name !== s.watched[index - 1]);
    expect(order).toEqual(["streaky", "dropper"]);
  });

  it("finishes every live maintained row in turn, then hands over to Drops", async () => {
    const s = setup({
      drop: true,
      channels: ["first", "second"],
      streaks: ["first", "second"],
      order: [...DEFAULT_SETTINGS.platform.twitch.watchSourcePriority],
    });
    for (let minute = 0; minute < 40; minute += 1) await s.tick();
    const order = s.watched.filter((name, index) => name !== s.watched[index - 1]);
    expect(order).toEqual(["first", "second", "dropper"]);
    expect(s.state.sessions.twitch.campaignId).toBe("drop");
  });

  it("puts Watch streaks first in an order saved before it", () => {
    expect(
      mergeSettings({
        platform: {
          twitch: { watchSourcePriority: ["drops", "nopixel", "fortnite", "watchlist"] },
          kick: { watchSourcePriority: ["watchlist", "drops"] },
        },
      } as never).platform,
    ).toMatchObject({
      twitch: {
        watchSourcePriority: ["watch_streaks", "drops", "nopixel", "fortnite", "watchlist"],
      },
      kick: { watchSourcePriority: ["watchlist", "drops"] },
    });
  });
});

describe("watch-streak source in a selection that resolves Drops itself", () => {
  // The drop's window is relative to T0, so the clock is too: on the real clock
  // its 100 hours stop fitting before it ends and the drop reads as unfinishable.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ORDER: WatchSourceId[] = ["watch_streaks", "drops", "nopixel", "fortnite", "watchlist"];

  function decide(options: { verdict: WatchStreakVerdict; drop: boolean; subscription?: boolean }) {
    const settings = applySettingsPatch(DEFAULT_SETTINGS, {
      platform: {
        twitch: {
          enabled: true,
          watchSourcePriority: ORDER,
          watchlistChannels: ["streaky", "ordinary"],
          watchlistStreakChannels: ["streaky"],
        },
      },
    });
    const campaign: DropCampaign = {
      id: "drop",
      platform: "twitch",
      name: "Drop",
      categoryId: "game",
      gameName: "Game",
      status: "active",
      startsAt: new Date(T0 - 3_600_000).toISOString(),
      endsAt: new Date(T0 + 7 * 86_400_000).toISOString(),
      accountLinked: true,
      eligibility: "eligible",
      priority: 1,
      rewards: [
        {
          id: "reward",
          name: "Reward",
          requiredMinutes: options.subscription ? 0 : 6000,
          watchedMinutes: 0,
          status: "in_progress",
          ...(options.subscription ? { requiredSubs: 1 } : {}),
        },
      ],
    };
    const plan: IdleWatchlistStreakPlan = {
      maintained: ["streaky"],
      prioritized: ["streaky"],
      verdict: () => options.verdict,
    };
    return chooseCampaignDecision(
      "twitch",
      options.drop || options.subscription ? [campaign] : [],
      settings,
      {
        listCandidateChannels: async () =>
          options.drop ? [{ ...channel("dropper"), isAclMatch: true }] : [],
        checkChannel: async (candidate) => ({
          live: true,
          categoryMatches: true,
          candidate: { ...channel(candidate.username.toLowerCase()), url: candidate.url },
        }),
      },
      undefined,
      undefined,
      undefined,
      true,
      plan,
    );
  }

  it("takes a pending streak row ahead of a farmable drop", async () => {
    const decision = await decide({ verdict: "pending", drop: true });
    expect(decision.channel?.username).toBe("streaky");
  });

  it("takes the drop once the streak is credited", async () => {
    const decision = await decide({ verdict: "credited", drop: true });
    expect(decision).toMatchObject({ action: "watch", channel: { username: "dropper" } });
  });

  it("keeps the finished streak row in its ordinary watchlist place without a drop", async () => {
    const decision = await decide({ verdict: "not_confirmed", drop: false });
    expect(decision.channel?.username).toBe("streaky");
  });

  it("keeps an opted-in streak but not the plain watchlist when only subscriptions remain", async () => {
    const sub = { drop: false, subscription: true } as const;
    expect((await decide({ ...sub, verdict: "pending" })).channel?.username).toBe("streaky");
    const finished = await decide({ ...sub, verdict: "credited" });
    expect(finished).toMatchObject({ action: "idle", reasonCode: "campaign_ineligible" });
  });
});
