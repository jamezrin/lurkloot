import { describe, expect, it } from "vitest";
import {
  nextWatchPauseBoundary,
  normalizeWatchPauseSchedule,
  watchPausedBySchedule,
  watchPauseScheduleIssues,
  watchPauseWindowAt,
  type WatchPauseSchedule,
} from "@lurkloot/shared/watchPauseSchedule";
import { DEFAULT_SETTINGS, mergeEngineSettings } from "@lurkloot/shared/settings";

// The daily watch pause window (#1162). Every case reads a fixed instant, so
// nothing here depends on the machine's clock or zone.

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

function schedule(patch: Partial<WatchPauseSchedule> = {}): WatchPauseSchedule {
  return { enabled: true, start: "01:00", end: "07:00", timeZone: "UTC", ...patch };
}

describe("watch pause window", () => {
  it("is off by default and when disabled", () => {
    expect(DEFAULT_SETTINGS.watchPauseSchedule.enabled).toBe(false);
    expect(
      watchPauseWindowAt(DEFAULT_SETTINGS.watchPauseSchedule, at("2026-07-01T03:00:00Z")),
    ).toBe(undefined);
    expect(watchPausedBySchedule(undefined, at("2026-07-01T03:00:00Z"))).toBe(false);
  });

  it("applies from the start, inclusive, to the end, exclusive", () => {
    const value = schedule();
    expect(watchPausedBySchedule(value, at("2026-07-01T00:59:59Z"))).toBe(false);
    expect(watchPausedBySchedule(value, at("2026-07-01T01:00:00Z"))).toBe(true);
    expect(watchPausedBySchedule(value, at("2026-07-01T06:59:59Z"))).toBe(true);
    expect(watchPausedBySchedule(value, at("2026-07-01T07:00:00Z"))).toBe(false);
  });

  it("reports the next resume while active and the next pause otherwise", () => {
    const value = schedule();
    expect(watchPauseWindowAt(value, at("2026-07-01T03:00:00Z"))).toEqual({
      active: true,
      startedAt: at("2026-07-01T01:00:00Z"),
      resumesAt: at("2026-07-01T07:00:00Z"),
    });
    expect(watchPauseWindowAt(value, at("2026-07-01T12:00:00Z"))).toEqual({
      active: false,
      pausesAt: at("2026-07-02T01:00:00Z"),
      resumesAt: at("2026-07-02T07:00:00Z"),
    });
    expect(iso(nextWatchPauseBoundary(value, at("2026-07-01T03:00:00Z")))).toBe(
      "2026-07-01T07:00:00.000Z",
    );
    expect(iso(nextWatchPauseBoundary(value, at("2026-07-01T00:30:00Z")))).toBe(
      "2026-07-01T01:00:00.000Z",
    );
  });

  it("crosses midnight when the start is after the end", () => {
    const value = schedule({ start: "22:00", end: "06:00" });
    // Before midnight: tonight's window.
    expect(watchPauseWindowAt(value, at("2026-07-01T23:00:00Z"))).toMatchObject({
      active: true,
      resumesAt: at("2026-07-02T06:00:00Z"),
    });
    // After midnight: the window that started yesterday.
    expect(watchPauseWindowAt(value, at("2026-07-02T03:00:00Z"))).toMatchObject({
      active: true,
      startedAt: at("2026-07-01T22:00:00Z"),
      resumesAt: at("2026-07-02T06:00:00Z"),
    });
    expect(watchPauseWindowAt(value, at("2026-07-02T12:00:00Z"))).toEqual({
      active: false,
      pausesAt: at("2026-07-02T22:00:00Z"),
      resumesAt: at("2026-07-03T06:00:00Z"),
    });
  });

  it("reads the times in the schedule's zone", () => {
    // Europe/Madrid is UTC+2 in summer, UTC+1 in winter.
    const madrid = schedule({ timeZone: "Europe/Madrid" });
    expect(watchPauseWindowAt(madrid, at("2026-07-01T00:30:00Z"))).toMatchObject({
      active: true,
      resumesAt: at("2026-07-01T05:00:00Z"),
    });
    expect(watchPauseWindowAt(madrid, at("2026-01-15T00:30:00Z"))).toMatchObject({
      active: true,
      resumesAt: at("2026-01-15T06:00:00Z"),
    });
    // A half-hour zone with no daylight saving.
    const kolkata = schedule({ start: "23:30", end: "05:30", timeZone: "Asia/Kolkata" });
    expect(watchPauseWindowAt(kolkata, at("2026-07-01T18:00:00Z"))).toMatchObject({
      active: true,
      startedAt: at("2026-07-01T18:00:00Z"),
      resumesAt: at("2026-07-02T00:00:00Z"),
    });
  });

  describe("daylight saving (Europe/Madrid, 2026)", () => {
    // Spring forward: 2026-03-29, 02:00 CET jumps to 03:00 CEST at 01:00Z.
    // Fall back: 2026-10-25, 03:00 CEST returns to 02:00 CET at 01:00Z.
    const madrid = (start: string, end: string) =>
      schedule({ start, end, timeZone: "Europe/Madrid" });

    it("starts a window whose start the clock skips at the jump", () => {
      const value = madrid("02:30", "06:00");
      expect(watchPausedBySchedule(value, at("2026-03-29T00:59:59Z"))).toBe(false);
      expect(iso(nextWatchPauseBoundary(value, at("2026-03-29T00:30:00Z")))).toBe(
        "2026-03-29T01:00:00.000Z",
      );
      expect(watchPauseWindowAt(value, at("2026-03-29T01:00:00Z"))).toMatchObject({
        active: true,
        resumesAt: at("2026-03-29T04:00:00Z"),
      });
    });

    it("ends a window whose end the clock skips at the jump", () => {
      const value = madrid("23:00", "02:30");
      expect(watchPauseWindowAt(value, at("2026-03-29T00:30:00Z"))).toMatchObject({
        active: true,
        startedAt: at("2026-03-28T22:00:00Z"),
        resumesAt: at("2026-03-29T01:00:00Z"),
      });
      expect(watchPausedBySchedule(value, at("2026-03-29T01:00:00Z"))).toBe(false);
    });

    it("skips a night whose whole window falls in the gap", () => {
      const value = madrid("02:10", "02:40");
      expect(watchPausedBySchedule(value, at("2026-03-29T01:00:00Z"))).toBe(false);
      expect(iso(nextWatchPauseBoundary(value, at("2026-03-29T00:30:00Z")))).toBe(
        "2026-03-30T00:10:00.000Z",
      );
    });

    it("ends at the first occurrence of a repeated end time and does not pause again", () => {
      const value = madrid("22:00", "02:30");
      // 02:30 CEST, the first time the clock reads 02:30.
      expect(watchPauseWindowAt(value, at("2026-10-25T00:00:00Z"))).toMatchObject({
        active: true,
        resumesAt: at("2026-10-25T00:30:00Z"),
      });
      expect(watchPausedBySchedule(value, at("2026-10-25T00:45:00Z"))).toBe(false);
      // 02:15 CET, the repeated hour: still resumed.
      expect(watchPausedBySchedule(value, at("2026-10-25T01:15:00Z"))).toBe(false);
      expect(watchPausedBySchedule(value, at("2026-10-25T01:29:59Z"))).toBe(false);
      expect(iso(nextWatchPauseBoundary(value, at("2026-10-25T01:15:00Z")))).toBe(
        "2026-10-25T21:00:00.000Z",
      );
    });

    it("starts at the first occurrence of a repeated start time", () => {
      const value = madrid("02:30", "05:00");
      expect(watchPauseWindowAt(value, at("2026-10-25T00:30:00Z"))).toEqual({
        active: true,
        startedAt: at("2026-10-25T00:30:00Z"),
        // 05:00 CET: three and a half hours on this night.
        resumesAt: at("2026-10-25T04:00:00Z"),
      });
      // Still the same window through the repeated hour.
      expect(watchPausedBySchedule(value, at("2026-10-25T01:30:00Z"))).toBe(true);
    });

    it("never flaps across a transition night, sampled every minute", () => {
      for (const [start, end, day] of [
        ["22:00", "02:30", "2026-10-24T18:00:00Z"],
        ["02:30", "05:00", "2026-10-24T18:00:00Z"],
        ["23:00", "02:30", "2026-03-28T18:00:00Z"],
        ["02:30", "06:00", "2026-03-28T18:00:00Z"],
      ] as const) {
        const value = madrid(start, end);
        let changes = 0;
        let previous = watchPausedBySchedule(value, at(day));
        for (let minute = 1; minute <= 12 * 60; minute += 1) {
          const paused = watchPausedBySchedule(value, at(day) + minute * 60_000);
          if (paused !== previous) changes += 1;
          previous = paused;
        }
        expect(changes, `${start}-${end}`).toBe(2);
      }
    });
  });

  describe("validation", () => {
    it("names every problem", () => {
      expect(watchPauseScheduleIssues(schedule())).toEqual([]);
      expect(watchPauseScheduleIssues(schedule({ start: "24:00" }))).toEqual(["invalid_start"]);
      expect(watchPauseScheduleIssues(schedule({ end: "7:00" }))).toEqual(["invalid_end"]);
      expect(watchPauseScheduleIssues(schedule({ start: "05:00", end: "05:00" }))).toEqual([
        "same_time",
      ]);
      expect(watchPauseScheduleIssues(schedule({ timeZone: "Mars/Olympus" }))).toEqual([
        "invalid_time_zone",
      ]);
      expect(watchPauseScheduleIssues(schedule({ timeZone: "" }))).toEqual(["invalid_time_zone"]);
    });

    it("never runs a schedule with a problem", () => {
      const now = at("2026-07-01T05:00:00Z");
      expect(watchPausedBySchedule(schedule({ start: "05:00", end: "05:00" }), now)).toBe(false);
      expect(watchPausedBySchedule(schedule({ timeZone: "Nowhere/City" }), now)).toBe(false);
      expect(watchPausedBySchedule(schedule({ start: "nope" }), now)).toBe(false);
    });

    it("normalizes stored values and switches an unusable schedule off", () => {
      expect(normalizeWatchPauseSchedule(undefined)).toEqual(DEFAULT_SETTINGS.watchPauseSchedule);
      expect(
        normalizeWatchPauseSchedule({
          enabled: true,
          start: " 22:00 ",
          end: "06:00",
          timeZone: "UTC",
        }),
      ).toEqual({ enabled: true, start: "22:00", end: "06:00", timeZone: "UTC" });
      expect(
        normalizeWatchPauseSchedule({
          enabled: true,
          start: "03:00",
          end: "03:00",
          timeZone: "UTC",
        }),
      ).toMatchObject({ enabled: false });
      expect(
        normalizeWatchPauseSchedule({
          enabled: true,
          start: "03:00",
          end: "04:00",
          timeZone: "Bad/Zone",
        }),
      ).toEqual({ enabled: false, start: "03:00", end: "04:00", timeZone: "UTC" });
      expect(normalizeWatchPauseSchedule({ enabled: "yes", start: 3 })).toEqual(
        DEFAULT_SETTINGS.watchPauseSchedule,
      );
      expect(
        mergeEngineSettings({ watchPauseSchedule: schedule({ start: "22:00" }) })
          .watchPauseSchedule,
      ).toEqual(schedule({ start: "22:00" }));
    });
  });
});
