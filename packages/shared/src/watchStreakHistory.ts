import type { WatchStreakDayOutcome } from "./models";

// The watch-streak day history (#897): what Lurkloot saw of each maintained
// channel, one outcome per local day. The engine writes it from finished
// attempts (packages/core/src/core/watchStreaks.ts); the popup draws it. It is
// a record of Lurkloot's own attempts and payouts, never the platform's own
// streak count, which no platform reports.

// How long a day stays in the history: twelve weeks, the popup's heatmap.
export const WATCH_STREAK_HISTORY_DAYS = 84;
// The most channels the history keeps, newest activity first.
export const WATCH_STREAK_HISTORY_MAX_CHANNELS = 100;

export type WatchStreakHistory = Record<string, Record<string, WatchStreakDayOutcome>>;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isWatchStreakDayKey(value: string): boolean {
  // Round-trips, so a day the calendar would roll over (2026-02-30) is refused.
  return DAY_KEY.test(value) && localDayKey(dayKeyToDate(value).getTime()) === value;
}

// The local calendar day of `ms`, as YYYY-MM-DD.
export function localDayKey(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Local midnight of a day key.
export function dayKeyToDate(key: string): Date {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day);
}

// The day key `days` calendar days after `key` (negative: before). Calendar
// arithmetic, so a daylight-saving change never skips or repeats a day.
export function shiftDayKey(key: string, days: number): string {
  const date = dayKeyToDate(key);
  date.setDate(date.getDate() + days);
  return localDayKey(date.getTime());
}

// A credited day stays credited: a later broadcast that day being missed does
// not take back a payout the platform already made.
export function strongerDayOutcome(
  left: WatchStreakDayOutcome | undefined,
  right: WatchStreakDayOutcome | undefined,
): WatchStreakDayOutcome | undefined {
  if (left === "credited" || right === "credited") return "credited";
  return left ?? right;
}

export function mergeWatchStreakHistory(
  left: WatchStreakHistory | undefined,
  right: WatchStreakHistory | undefined,
): WatchStreakHistory | undefined {
  if (!left) return right;
  if (!right) return left;
  const merged: WatchStreakHistory = {};
  for (const channel of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const days: Record<string, WatchStreakDayOutcome> = { ...left[channel] };
    for (const [day, outcome] of Object.entries(right[channel] ?? {})) {
      days[day] = strongerDayOutcome(days[day], outcome)!;
    }
    merged[channel] = days;
  }
  return merged;
}

// Drops days older than the window and channels left with none, keeping at
// most WATCH_STREAK_HISTORY_MAX_CHANNELS by most recent day.
export function pruneWatchStreakHistory(
  history: WatchStreakHistory | undefined,
  now: number,
): WatchStreakHistory | undefined {
  if (!history) return undefined;
  const oldest = shiftDayKey(localDayKey(now), -(WATCH_STREAK_HISTORY_DAYS - 1));
  const channels: Array<[string, Record<string, WatchStreakDayOutcome>, string]> = [];
  for (const [channel, days] of Object.entries(history)) {
    const kept: Record<string, WatchStreakDayOutcome> = {};
    let newest = "";
    for (const [day, outcome] of Object.entries(days)) {
      if (day < oldest) continue;
      kept[day] = outcome;
      if (day > newest) newest = day;
    }
    if (newest) channels.push([channel, kept, newest]);
  }
  if (channels.length === 0) return undefined;
  channels.sort((left, right) => (left[2] < right[2] ? 1 : left[2] > right[2] ? -1 : 0));
  return Object.fromEntries(
    channels.slice(0, WATCH_STREAK_HISTORY_MAX_CHANNELS).map(([channel, days]) => [channel, days]),
  );
}

// One maintained channel's run: its latest credited days in a row. Days with no
// record (the channel was offline, or Lurkloot was not running) neither add to
// the run nor break it, as a stream nobody saw cannot break a streak either.
// `atRisk`: the latest recorded day was missed, so the run shown is the one
// before that miss, which the platform may or may not have kept.
export function channelStreakRun(
  days: Readonly<Record<string, WatchStreakDayOutcome>> | undefined,
): { run: number; atRisk: boolean } {
  const ordered = Object.keys(days ?? {})
    .sort()
    .reverse();
  let index = 0;
  while (index < ordered.length && days![ordered[index]!] === "missed") index += 1;
  let run = 0;
  while (index < ordered.length && days![ordered[index]!] === "credited") {
    run += 1;
    index += 1;
  }
  return { run, atRisk: ordered.length > 0 && days![ordered[0]!] === "missed" };
}

export interface WatchStreakHistorySummary {
  // Credited channel-days per day, across every channel.
  credited: Record<string, number>;
  // Days with at least one miss and no payout at all.
  missedOnly: Set<string>;
  // Credited channel-days in the window.
  totalCredited: number;
  // Days in a row, up to today, with a payout. Today does not break the run
  // while it has none yet.
  currentDayRun: number;
  // The longest such run in the window.
  bestDayRun: number;
}

export function summarizeWatchStreakHistory(
  history: WatchStreakHistory | undefined,
  now: number,
): WatchStreakHistorySummary {
  const credited: Record<string, number> = {};
  const missed = new Set<string>();
  let totalCredited = 0;
  for (const days of Object.values(history ?? {})) {
    for (const [day, outcome] of Object.entries(days)) {
      if (outcome === "credited") {
        credited[day] = (credited[day] ?? 0) + 1;
        totalCredited += 1;
      } else missed.add(day);
    }
  }
  const missedOnly = new Set([...missed].filter((day) => !credited[day]));
  const today = localDayKey(now);
  let currentDayRun = 0;
  let day = credited[today] ? today : shiftDayKey(today, -1);
  while (credited[day]) {
    currentDayRun += 1;
    day = shiftDayKey(day, -1);
  }
  let bestDayRun = 0;
  let running = 0;
  day = shiftDayKey(today, -(WATCH_STREAK_HISTORY_DAYS - 1));
  for (let index = 0; index < WATCH_STREAK_HISTORY_DAYS; index += 1) {
    running = credited[day] ? running + 1 : 0;
    bestDayRun = Math.max(bestDayRun, running);
    day = shiftDayKey(day, 1);
  }
  return { credited, missedOnly, totalCredited, currentDayRun, bestDayRun };
}
