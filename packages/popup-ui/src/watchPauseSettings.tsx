import { useEffect, useId, useState } from "react";
import {
  DEFAULT_WATCH_PAUSE_SCHEDULE,
  parseWatchPauseTime,
  watchPauseScheduleIssues,
  watchPauseWindowAt,
  type WatchPauseSchedule,
  type WatchPauseScheduleIssue,
} from "@lurkloot/shared/watchPauseSchedule";
import { useT } from "./context";
import { SettingRow } from "./settingsControls";
import { cn } from "./primitives";

const ISSUE_KEYS: Record<WatchPauseScheduleIssue, string> = {
  invalid_start: "watchPauseInvalidTime",
  invalid_end: "watchPauseInvalidTime",
  same_time: "watchPauseSameTime",
  invalid_time_zone: "watchPauseInvalidTimeZone",
};

// The zone this device's clock runs in, used as the starting zone the first
// time the schedule is turned on.
function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function supportedTimeZones(): string[] {
  try {
    const values = (Intl as { supportedValuesOf?(key: string): string[] }).supportedValuesOf?.(
      "timeZone",
    );
    return values ? ["UTC", ...values.filter((zone) => zone !== "UTC")] : ["UTC"];
  } catch {
    return ["UTC"];
  }
}

// A boundary instant as a short clock time. The zone is named only when it is
// not the viewer's own, so "07:00" reads as local and "07:00 GMT+1" does not
// pretend to be.
export function formatWatchPauseInstant(at: number, timeZone: string): string {
  const named = timeZone !== deviceTimeZone();
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
      ...(named ? { timeZoneName: "short" } : {}),
    }).format(at);
  } catch {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}

// Re-renders on a slow cadence so "Next pause at" follows the clock.
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);
  return now;
}

const FIELD_CLASS =
  "rounded-lg border border-zinc-200 bg-white px-2 py-1 text-[11px] font-semibold tabular text-zinc-800 outline-none focus-visible:border-[var(--accent-ring)] aria-[invalid=true]:border-red-500/60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

// The daily watch pause editor (#1162). Edits a draft and saves only a valid
// schedule, so an invalid one is shown and never stored; the engine re-checks
// on its own after every save.
export function WatchPauseScheduleSettings({
  schedule,
  onChange,
}: {
  schedule: WatchPauseSchedule;
  onChange(schedule: WatchPauseSchedule): void | Promise<void>;
}) {
  const t = useT();
  const now = useNow();
  const zonesId = useId();
  const [draft, setDraft] = useState(schedule);
  // Follows the stored schedule only when one of its values changes. Settings
  // refreshes hand down a new object with the same values, and resetting on
  // those would throw away a time zone the user is still typing.
  const { enabled, start: storedStart, end: storedEnd, timeZone } = schedule;
  useEffect(
    () => setDraft({ enabled, start: storedStart, end: storedEnd, timeZone }),
    [enabled, storedStart, storedEnd, timeZone],
  );

  const issues = watchPauseScheduleIssues(draft);
  const commit = (next: WatchPauseSchedule) => {
    setDraft(next);
    if (watchPauseScheduleIssues(next).length > 0) return;
    if (
      next.enabled === schedule.enabled
      && next.start === schedule.start
      && next.end === schedule.end
      && next.timeZone === schedule.timeZone
    )
      return;
    void onChange(next);
  };
  const toggle = (enabled: boolean) => {
    // Turned on for the first time, the schedule still has the stored default
    // zone; this device's zone is far more likely to be what the user means.
    const timeZone =
      enabled && draft.timeZone === DEFAULT_WATCH_PAUSE_SCHEDULE.timeZone
        ? deviceTimeZone()
        : draft.timeZone;
    commit({ ...draft, enabled, timeZone });
  };

  const pauseWindow = issues.length === 0 ? watchPauseWindowAt(draft, now) : undefined;
  const start = parseWatchPauseTime(draft.start);
  const end = parseWatchPauseTime(draft.end);
  const overnight = start !== undefined && end !== undefined && end < start;
  const issueMessages = [...new Set(issues.map((issue) => t(ISSUE_KEYS[issue])))];

  return (
    <div data-watch-pause-settings>
      <SettingRow
        title={t("watchPauseTitle")}
        description={t("watchPauseDescription")}
        checked={draft.enabled}
        onChange={toggle}
      />
      {draft.enabled ? (
        <div className="pb-2.5">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              {t("watchPauseStartLabel")}
              <input
                type="time"
                data-watch-pause-start
                value={draft.start}
                aria-invalid={issues.includes("invalid_start") || issues.includes("same_time")}
                onChange={(event) => commit({ ...draft, start: event.currentTarget.value })}
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              {t("watchPauseEndLabel")}
              <input
                type="time"
                data-watch-pause-end
                value={draft.end}
                aria-invalid={issues.includes("invalid_end") || issues.includes("same_time")}
                onChange={(event) => commit({ ...draft, end: event.currentTarget.value })}
                className={FIELD_CLASS}
              />
            </label>
            <label className="flex min-w-[10rem] flex-1 flex-col gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              {t("watchPauseTimeZoneLabel")}
              <input
                type="text"
                data-watch-pause-time-zone
                list={zonesId}
                spellCheck={false}
                autoComplete="off"
                value={draft.timeZone}
                aria-invalid={issues.includes("invalid_time_zone")}
                onChange={(event) => setDraft({ ...draft, timeZone: event.currentTarget.value })}
                onBlur={(event) => commit({ ...draft, timeZone: event.currentTarget.value.trim() })}
                onKeyDown={(event) => {
                  if (event.key === "Enter")
                    commit({ ...draft, timeZone: event.currentTarget.value.trim() });
                }}
                className={cn(FIELD_CLASS, "w-full")}
              />
              <datalist id={zonesId}>
                {supportedTimeZones().map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </label>
          </div>
          <div
            data-watch-pause-status
            aria-live="polite"
            className={cn(
              "mt-1.5 text-[11px] leading-snug",
              issueMessages.length > 0
                ? "text-red-600 dark:text-red-400"
                : "text-zinc-500 dark:text-zinc-400",
            )}
          >
            {issueMessages.length > 0
              ? issueMessages.join(" ")
              : [
                  overnight ? t("watchPauseOvernightHint") : undefined,
                  pauseWindow?.active
                    ? t(
                        "watchPauseActiveNow",
                        formatWatchPauseInstant(pauseWindow.resumesAt, draft.timeZone),
                      )
                    : pauseWindow
                      ? t(
                          "watchPauseNextStart",
                          formatWatchPauseInstant(pauseWindow.pausesAt, draft.timeZone),
                        )
                      : undefined,
                ]
                  .filter(Boolean)
                  .join(" ")}
          </div>
        </div>
      ) : null}
    </div>
  );
}
