// The daily watch pause window (#1162): one optional window, set as wall-clock
// start and end times in a named IANA time zone, during which every host stops
// its managed watches and starts no new ones. Claims and account health keep
// running. Everything here is pure and takes the clock as an argument, so the
// engine, the popup and the CLI all read the same answer for the same instant.
//
// Daylight-saving behavior, the contract docs/architecture.md repeats:
// - Times are wall-clock times in `timeZone`, so a 01:00–07:00 window stays
//   01:00–07:00 local all year.
// - A time the clock skips (spring forward, e.g. 02:30 when 02:00 jumps to
//   03:00) resolves to the moment the clock jumps: the first instant after the
//   gap. A window that starts or ends in the gap starts or ends there.
// - A time the clock repeats (fall back, e.g. 01:30 when 02:00 returns to
//   01:00) resolves to its first occurrence. A window that ends in the repeated
//   hour ends the first time the clock reads its end, and the repeat does not
//   pause again; one that starts there starts on the first pass.
// - So on a transition night a window can run up to an hour shorter or longer
//   in elapsed time. It never runs twice in one night and never flaps.
// - A window whose start and end both fall in the same gap is empty that night.

export interface WatchPauseSchedule {
  enabled: boolean;
  // "HH:MM", 24-hour.
  start: string;
  end: string;
  // An IANA zone name, such as "Europe/Madrid" or "UTC".
  timeZone: string;
}

export const DEFAULT_WATCH_PAUSE_SCHEDULE: Readonly<WatchPauseSchedule> = {
  enabled: false,
  start: "01:00",
  end: "07:00",
  timeZone: "UTC",
};

export type WatchPauseScheduleIssue =
  | "invalid_start"
  | "invalid_end"
  | "same_time"
  | "invalid_time_zone";

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Minutes after midnight, or undefined when `value` is not "HH:MM".
export function parseWatchPauseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = TIME_PATTERN.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat | undefined {
  const cached = zoneFormatters.get(timeZone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(timeZone, formatter);
    return formatter;
  } catch {
    return undefined;
  }
}

export function isValidTimeZone(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && zoneFormatter(value) !== undefined;
}

// Every problem with a schedule's values, whether or not it is enabled. The
// popup shows them and the CLI rejects a config that has any.
export function watchPauseScheduleIssues(
  schedule: Pick<WatchPauseSchedule, "start" | "end" | "timeZone">,
): WatchPauseScheduleIssue[] {
  const issues: WatchPauseScheduleIssue[] = [];
  const start = parseWatchPauseTime(schedule.start);
  const end = parseWatchPauseTime(schedule.end);
  if (start === undefined) issues.push("invalid_start");
  if (end === undefined) issues.push("invalid_end");
  if (start !== undefined && start === end) issues.push("same_time");
  if (!isValidTimeZone(schedule.timeZone)) issues.push("invalid_time_zone");
  return issues;
}

// Shared by every host's normalization. A value that cannot be read falls back
// to its default, and a schedule with any issue is switched off, so the engine
// never runs a window nobody could have meant.
export function normalizeWatchPauseSchedule(value: unknown): WatchPauseSchedule {
  const raw =
    value !== null && typeof value === "object" ? (value as Partial<WatchPauseSchedule>) : {};
  const text = (field: unknown, fallback: string) =>
    typeof field === "string" && field.trim() !== "" ? field.trim() : fallback;
  const schedule: WatchPauseSchedule = {
    enabled: raw.enabled === true,
    start: text(raw.start, DEFAULT_WATCH_PAUSE_SCHEDULE.start),
    end: text(raw.end, DEFAULT_WATCH_PAUSE_SCHEDULE.end),
    timeZone: text(raw.timeZone, DEFAULT_WATCH_PAUSE_SCHEDULE.timeZone),
  };
  if (parseWatchPauseTime(schedule.start) === undefined)
    schedule.start = DEFAULT_WATCH_PAUSE_SCHEDULE.start;
  if (parseWatchPauseTime(schedule.end) === undefined)
    schedule.end = DEFAULT_WATCH_PAUSE_SCHEDULE.end;
  if (!isValidTimeZone(schedule.timeZone)) {
    schedule.timeZone = DEFAULT_WATCH_PAUSE_SCHEDULE.timeZone;
    schedule.enabled = false;
  }
  if (watchPauseScheduleIssues(schedule).length > 0) schedule.enabled = false;
  return schedule;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  minutes: number;
}

// `at` as wall-clock fields in the zone, encoded as if they were UTC.
function wallAsUtc(formatter: Intl.DateTimeFormat, at: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour! % 24,
    parts.minute!,
    parts.second!,
  );
}

// The zone's UTC offset at `at`, in milliseconds, to the second.
function offsetAt(formatter: Intl.DateTimeFormat, at: number): number {
  const whole = Math.floor(at / 1000) * 1000;
  return wallAsUtc(formatter, whole) - whole;
}

function wallClockAt(formatter: Intl.DateTimeFormat, at: number): WallClock {
  const wall = new Date(wallAsUtc(formatter, at));
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    minutes: wall.getUTCHours() * 60 + wall.getUTCMinutes(),
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// The instant the zone's clock reads `minutes` on the given local date, with
// the DST rules above: the first occurrence of a repeated time, and the end of
// the gap for a skipped one.
function resolveWallTime(
  formatter: Intl.DateTimeFormat,
  date: { year: number; month: number; day: number },
  minutes: number,
): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minutes);
  const offsets = new Set([
    offsetAt(formatter, wall - DAY_MS),
    offsetAt(formatter, wall),
    offsetAt(formatter, wall + DAY_MS),
  ]);
  const matches = [...offsets]
    .map((offset) => wall - offset)
    .filter((candidate) => offsetAt(formatter, candidate) === wall - candidate);
  if (matches.length > 0) return Math.min(...matches);
  // In a gap: no instant reads `wall`. The clock jumps somewhere between the
  // two readings; find the first instant past it, to the second.
  let low = wall - Math.max(...offsets);
  let high = wall - Math.min(...offsets);
  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2000) * 1000;
    if (wallAsUtc(formatter, middle) >= wall) high = middle;
    else low = middle;
  }
  return high;
}

function shiftDate(date: { year: number; month: number; day: number }, days: number) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export type WatchPauseWindowState =
  // The window applies now; farming resumes at `resumesAt`.
  | { active: true; startedAt: number; resumesAt: number }
  // The window does not apply now; it next starts at `pausesAt`.
  | { active: false; pausesAt: number; resumesAt: number };

// Where `now` falls against the schedule, or undefined when the schedule is off
// or cannot be read. Each window belongs to the local date it starts on, and an
// overnight one (start after end) ends on the next date.
export function watchPauseWindowAt(
  schedule: WatchPauseSchedule | undefined,
  now: number,
): WatchPauseWindowState | undefined {
  if (!schedule?.enabled || watchPauseScheduleIssues(schedule).length > 0) return undefined;
  const formatter = zoneFormatter(schedule.timeZone)!;
  const start = parseWatchPauseTime(schedule.start)!;
  const end = parseWatchPauseTime(schedule.end)!;
  const overnight = end < start;
  const today = wallClockAt(formatter, now);
  let next: { startsAt: number; endsAt: number } | undefined;
  // Yesterday's window can still be running past midnight, and today's or
  // tomorrow's is the next one; three dates always cover both.
  for (const offset of [-1, 0, 1, 2]) {
    const date = shiftDate(today, offset);
    const startsAt = resolveWallTime(formatter, date, start);
    const endsAt = resolveWallTime(formatter, overnight ? shiftDate(date, 1) : date, end);
    if (endsAt <= startsAt) continue;
    if (startsAt <= now && now < endsAt)
      return { active: true, startedAt: startsAt, resumesAt: endsAt };
    if (startsAt > now && (!next || startsAt < next.startsAt)) next = { startsAt, endsAt };
  }
  if (!next) return undefined;
  return { active: false, pausesAt: next.startsAt, resumesAt: next.endsAt };
}

// Whether the schedule pauses watching at `now`.
export function watchPausedBySchedule(
  schedule: WatchPauseSchedule | undefined,
  now: number,
): boolean {
  return watchPauseWindowAt(schedule, now)?.active === true;
}

// The next instant the answer to watchPausedBySchedule changes, for a host
// that wants to wake exactly then.
export function nextWatchPauseBoundary(
  schedule: WatchPauseSchedule | undefined,
  now: number,
): number | undefined {
  const window = watchPauseWindowAt(schedule, now);
  if (!window) return undefined;
  return window.active ? window.resumesAt : window.pausesAt;
}
