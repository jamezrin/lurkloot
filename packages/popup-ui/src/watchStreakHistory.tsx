import React from "react";
import { AlertTriangle, Flame } from "lucide-react";
import type { WatchStreakDayOutcome, WatchStreakRowStatus } from "@lurkloot/shared/models";
import {
  channelStreakRun,
  dayKeyToDate,
  localDayKey,
  shiftDayKey,
  summarizeWatchStreakHistory,
  type WatchStreakHistory,
} from "@lurkloot/shared/watchStreakHistory";
import { I18nContext, useT } from "./context";
import { cn } from "./primitives";
import { Tip } from "./tooltip";

// The Watchlist's watch-streak card (#897): twelve weeks of payouts as a
// heatmap with the day runs under it, then each maintained channel's last two
// weeks and its run. Everything here is what Lurkloot itself saw, so the copy
// never calls a number the platform's own streak count.

const HEATMAP_WEEKS = 12;
const STRIP_DAYS = 14;

export interface WatchStreakHistoryCardProps {
  history: WatchStreakHistory | undefined;
  // Maintained channels, lowercased, in Watchlist order.
  channels: readonly string[];
  statuses: Readonly<Record<string, WatchStreakRowStatus>>;
  now?: number;
}

export function WatchStreakHistoryCard({
  history,
  channels,
  statuses,
  now = Date.now(),
}: WatchStreakHistoryCardProps): React.ReactElement {
  const t = useT();
  const { locale } = React.useContext(I18nContext);
  const tag = locale.replace(/_/g, "-");
  const summary = summarizeWatchStreakHistory(history, now);
  const today = localDayKey(now);
  const number = new Intl.NumberFormat(tag);
  const dayFormat = new Intl.DateTimeFormat(tag, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const formatDay = (key: string) => dayFormat.format(dayKeyToDate(key));

  return (
    <section
      data-watch-streak-history
      aria-label={t("watchStreakHistoryTitle")}
      className="overflow-hidden rounded-xl border border-[var(--surface-edge)] bg-white dark:bg-zinc-900"
    >
      <div className="flex items-center gap-1.5 px-3 pt-2.5">
        <Flame size={12} aria-hidden className="shrink-0 text-orange-500" />
        <span className="text-[11px] font-semibold text-zinc-900 dark:text-zinc-50">
          {t("watchStreakHistoryTitle")}
        </span>
        <span className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">
          {t("watchStreakHistoryWindow")}
        </span>
      </div>

      <Heatmap
        today={today}
        credited={summary.credited}
        missedOnly={summary.missedOnly}
        tag={tag}
        describe={(key, count) =>
          t("watchStreakHistoryDayTip", [formatDay(key), number.format(count)])
        }
      />

      <dl className="grid grid-cols-3 border-t border-[var(--surface-edge)] text-center">
        <Stat
          id="total"
          value={number.format(summary.totalCredited)}
          label={t("watchStreakHistoryTotal")}
        />
        <Stat
          id="current"
          value={number.format(summary.currentDayRun)}
          label={t("watchStreakHistoryDayRun")}
        />
        <Stat
          id="best"
          value={number.format(summary.bestDayRun)}
          label={t("watchStreakHistoryBestRun")}
          flame={summary.bestDayRun > 0}
        />
      </dl>

      {channels.length > 0 ? (
        <div className="border-t border-[var(--surface-edge)] px-3 py-2">
          <div className="mb-1 text-[10px] font-semibold tracking-wide text-zinc-400 uppercase dark:text-zinc-500">
            {t("watchStreakHistoryChannels", String(STRIP_DAYS))}
          </div>
          <ul className="space-y-1">
            {channels.map((channel) => (
              <ChannelStrip
                key={channel}
                channel={channel}
                days={history?.[channel]}
                status={statuses[channel]}
                today={today}
                formatDay={formatDay}
                formatNumber={(value) => number.format(value)}
              />
            ))}
          </ul>
        </div>
      ) : null}

      <p className="border-t border-[var(--surface-edge)] px-3 py-1.5 text-[10px] text-zinc-400 dark:text-zinc-500">
        {summary.totalCredited === 0 && !hasAnyDay(history)
          ? t("watchStreakHistoryEmpty")
          : t("watchStreakHistoryNote")}
      </p>
    </section>
  );
}

function hasAnyDay(history: WatchStreakHistory | undefined): boolean {
  return Object.values(history ?? {}).some((days) => Object.keys(days).length > 0);
}

function Stat({
  id,
  value,
  label,
  flame = false,
}: {
  id: string;
  value: string;
  label: string;
  flame?: boolean;
}): React.ReactElement {
  return (
    <div data-watch-streak-stat={id} className="px-1 py-2">
      <dd className="flex items-center justify-center gap-0.5 text-sm font-semibold text-zinc-900 tabular dark:text-zinc-50">
        {flame ? <Flame size={12} aria-hidden className="text-orange-500" /> : null}
        {value}
      </dd>
      <dt className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">{label}</dt>
    </div>
  );
}

// Monday-first weeks, oldest on the left, ending with the current week.
function heatmapWeeks(today: string): string[][] {
  const weekday = (dayKeyToDate(today).getDay() + 6) % 7;
  const firstMonday = shiftDayKey(today, -weekday - (HEATMAP_WEEKS - 1) * 7);
  return Array.from({ length: HEATMAP_WEEKS }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => shiftDayKey(firstMonday, week * 7 + day)),
  );
}

function heatLevel(count: number): string {
  if (count >= 3) return "bg-orange-500";
  if (count === 2) return "bg-orange-500/70";
  return "bg-orange-500/45";
}

function Heatmap({
  today,
  credited,
  missedOnly,
  tag,
  describe,
}: {
  today: string;
  credited: Readonly<Record<string, number>>;
  missedOnly: ReadonlySet<string>;
  tag: string;
  describe(key: string, count: number): string;
}): React.ReactElement {
  const weeks = heatmapWeeks(today);
  const month = new Intl.DateTimeFormat(tag, { month: "short" });
  return (
    <div data-watch-streak-heatmap className="flex justify-center px-3 pt-1.5 pb-2.5">
      <div
        className="grid grid-flow-col gap-[3px]"
        style={{ gridTemplateRows: "auto repeat(7, 13px)" }}
      >
        {weeks.map((week, index) => {
          const first = dayKeyToDate(week[0]!);
          const previous = index > 0 ? dayKeyToDate(weeks[index - 1]![0]!) : undefined;
          const label =
            !previous || previous.getMonth() !== first.getMonth() ? month.format(first) : "";
          return (
            <React.Fragment key={week[0]}>
              <span
                aria-hidden
                className="h-3 w-[13px] overflow-visible text-[9px] leading-3 whitespace-nowrap text-zinc-400 dark:text-zinc-500"
              >
                {label}
              </span>
              {week.map((key) => {
                if (key > today) return <span key={key} aria-hidden className="size-[13px]" />;
                const count = credited[key] ?? 0;
                return (
                  <Tip key={key} label={describe(key, count)}>
                    <span
                      data-day={key}
                      data-count={count}
                      className={cn(
                        "size-[13px] rounded-[3px]",
                        count > 0
                          ? heatLevel(count)
                          : missedOnly.has(key)
                            ? "bg-rose-500/25"
                            : "bg-zinc-100 dark:bg-zinc-800",
                        key === today
                          && "ring-1 ring-orange-500 ring-offset-1 ring-offset-white dark:ring-offset-zinc-900",
                      )}
                    />
                  </Tip>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

const CELL_KEY = {
  credited: "watchStreakHistoryCellCredited",
  missed: "watchStreakHistoryCellMissed",
} as const satisfies Record<WatchStreakDayOutcome, string>;

function ChannelStrip({
  channel,
  days,
  status,
  today,
  formatDay,
  formatNumber,
}: {
  channel: string;
  days: Readonly<Record<string, WatchStreakDayOutcome>> | undefined;
  status: WatchStreakRowStatus | undefined;
  today: string;
  formatDay(key: string): string;
  formatNumber(value: number): string;
}): React.ReactElement {
  const t = useT();
  const { run, atRisk } = channelStreakRun(days);
  const strip = Array.from({ length: STRIP_DAYS }, (_, index) =>
    shiftDayKey(today, index - (STRIP_DAYS - 1)),
  );
  const watching = status === "watching";
  return (
    <li data-watch-streak-channel={channel} className="flex items-center gap-2">
      <span
        className={cn(
          "w-20 shrink-0 truncate text-[11px] font-medium",
          atRisk ? "text-rose-600 dark:text-rose-400" : "text-zinc-700 dark:text-zinc-200",
        )}
      >
        {channel}
      </span>
      <span className="flex min-w-0 flex-1 gap-[2px]">
        {strip.map((key) => {
          const outcome = days?.[key];
          const live = key === today && !outcome && watching;
          return (
            <Tip
              key={key}
              label={t(
                outcome
                  ? CELL_KEY[outcome]
                  : live
                    ? "watchStreakWatching"
                    : "watchStreakHistoryCellNone",
                formatDay(key),
              )}
            >
              <span
                data-day={key}
                data-outcome={outcome ?? (live ? "watching" : "none")}
                className={cn(
                  "h-3 min-w-0 flex-1 rounded-[3px]",
                  outcome === "credited"
                    ? "bg-orange-500"
                    : outcome === "missed"
                      ? "bg-rose-500/60"
                      : live
                        ? "bg-[repeating-linear-gradient(135deg,rgb(249_115_22/0.55)_0_3px,rgb(249_115_22/0.2)_3px_6px)]"
                        : "bg-zinc-100 dark:bg-zinc-800",
                  key === today && "ring-1 ring-orange-500/70",
                )}
              />
            </Tip>
          );
        })}
      </span>
      <Tip
        label={
          atRisk
            ? t("watchStreakHistoryAtRisk", formatNumber(run))
            : t("watchStreakHistoryRunTip", formatNumber(run))
        }
      >
        <span
          data-watch-streak-run={run}
          className={cn(
            "flex w-10 shrink-0 items-center justify-end gap-0.5 text-[11px] font-semibold tabular",
            run > 0 ? "text-orange-600 dark:text-orange-400" : "text-zinc-400 dark:text-zinc-500",
          )}
        >
          {atRisk ? <AlertTriangle size={10} aria-hidden className="text-rose-500" /> : null}
          <Flame size={11} aria-hidden className={run > 0 ? "text-orange-500" : undefined} />
          {formatNumber(run)}
        </span>
      </Tip>
    </li>
  );
}
