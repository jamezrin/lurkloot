import React from "react";
import { AlertTriangle, Flame, Plus } from "lucide-react";
import type {
  WatchSourceId,
  WatchStreakDayOutcome,
  WatchStreakRowStatus,
} from "@lurkloot/shared/models";
import {
  channelStreakRun,
  dayKeyToDate,
  localDayKey,
  shiftDayKey,
  summarizeWatchStreakHistory,
  type WatchStreakHistory,
} from "@lurkloot/shared/watchStreakHistory";
import { I18nContext, useT } from "./context";
import { cn, EmptyPanel, Pill } from "./primitives";
import { Tip } from "./tooltip";
import { WatchSourcePlace } from "./watchSourcePriority";

// The Watchlist's Streaks tab (#897): twelve weeks of payouts as a heatmap
// beside the day runs, then each maintained channel's last two weeks and its
// run, and the Watchlist channels that could keep one. Everything here is what
// Lurkloot itself saw, so the copy never calls a number the platform's own
// streak count.

const HEATMAP_WEEKS = 12;
const STRIP_DAYS = 14;

/** Watch-streak maintenance on the Watchlist (#897). Only offered where the
 * platform maintains streaks (Twitch). */
export interface IdleWatchlistStreaks {
  // Rows the user opted in, lowercased.
  enabled: ReadonlySet<string>;
  // The last tick's status per opted-in row.
  statuses: Readonly<Record<string, WatchStreakRowStatus>>;
  // The watch budget an attempt gets (Advanced settings), for the hint.
  budgetMinutes: number;
  // What Lurkloot saw of each maintained channel, per day.
  history?: WatchStreakHistory;
  onToggle(username: string, enabled: boolean): void;
}

export function WatchStreaksTab({
  streaks,
  channels,
  watchOrder,
  onChangeOrder,
  onShowChannels,
  now,
}: {
  streaks: IdleWatchlistStreaks;
  // Every Watchlist channel, lowercased, in Watchlist order.
  channels: readonly string[];
  watchOrder?: readonly WatchSourceId[];
  onChangeOrder?(): void;
  onShowChannels(): void;
  now?: number;
}): React.ReactElement {
  const t = useT();
  const maintained = channels.filter((channel) => streaks.enabled.has(channel));
  const available = channels.filter((channel) => !streaks.enabled.has(channel));
  return (
    <div data-watch-streaks-tab className="space-y-2">
      {watchOrder && onChangeOrder && maintained.length > 0 ? (
        <WatchSourcePlace
          source="watch_streaks"
          order={watchOrder}
          onChangeOrder={onChangeOrder}
          named
        />
      ) : null}

      {maintained.length > 0 ? (
        <WatchStreakHistoryCard
          history={streaks.history}
          channels={maintained}
          statuses={streaks.statuses}
          onToggle={streaks.onToggle}
          now={now}
        />
      ) : channels.length > 0 ? (
        <EmptyPanel>{t("watchStreaksNone")}</EmptyPanel>
      ) : null}

      {channels.length === 0 ? (
        <EmptyPanel>
          <span className="block">{t("watchStreaksNoChannels")}</span>
          <button
            type="button"
            data-watch-streaks-show-channels
            onClick={onShowChannels}
            className="mt-2 inline-flex items-center gap-1 rounded-lg bg-[var(--ink)] px-3 py-1 text-xs font-semibold text-[var(--ink-contrast)]"
          >
            <Plus size={13} aria-hidden /> {t("watchStreaksAddChannels")}
          </button>
        </EmptyPanel>
      ) : available.length > 0 ? (
        <div data-watch-streaks-available className="space-y-1.5 pt-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
              {t("watchStreaksAvailableTitle")}
            </span>
            <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {available.map((channel) => (
              <button
                key={channel}
                type="button"
                data-watch-streaks-add={channel}
                aria-label={t("watchlistStreakToggle", channel)}
                onClick={() => streaks.onToggle(channel, true)}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--surface-edge)] bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 transition-colors outline-none hover:border-orange-500/50 hover:text-orange-600 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:bg-zinc-900 dark:text-zinc-200 dark:hover:text-orange-400"
              >
                <Plus size={11} aria-hidden />
                {channel}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <p
        data-watchlist-streak-hint
        className="flex items-start gap-1 px-1 text-[10px] text-zinc-400 dark:text-zinc-500"
      >
        <Flame size={10} aria-hidden className="mt-px shrink-0 text-orange-500" />
        {t("watchlistStreakHint", String(streaks.budgetMinutes))}
      </p>
    </div>
  );
}

export function WatchStreakHistoryCard({
  history,
  channels,
  statuses,
  onToggle,
  now = Date.now(),
}: {
  history: WatchStreakHistory | undefined;
  // Maintained channels, lowercased, in Watchlist order.
  channels: readonly string[];
  statuses: Readonly<Record<string, WatchStreakRowStatus>>;
  onToggle?(username: string, enabled: boolean): void;
  now?: number;
}): React.ReactElement {
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
      <div className="flex items-stretch">
        <div className="min-w-0 flex-1 px-3 pt-2.5 pb-3">
          <div className="mb-1.5 flex items-center gap-1.5">
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
        </div>
        <dl className="flex w-32 shrink-0 flex-col justify-center divide-y divide-[var(--surface-edge)] border-s border-[var(--surface-edge)]">
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
      </div>

      {channels.length > 0 ? (
        <div className="border-t border-[var(--surface-edge)] px-3 py-2">
          <div className="mb-1.5 text-[10px] font-semibold tracking-wide text-zinc-400 uppercase dark:text-zinc-500">
            {t("watchStreakHistoryChannels", String(STRIP_DAYS))}
          </div>
          <ul className="divide-y divide-[var(--surface-edge)]">
            {channels.map((channel) => (
              <ChannelStrip
                key={channel}
                channel={channel}
                days={history?.[channel]}
                status={statuses[channel]}
                today={today}
                formatDay={formatDay}
                formatNumber={(value) => number.format(value)}
                onToggle={onToggle ? (enabled) => onToggle(channel, enabled) : undefined}
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
    <div data-watch-streak-stat={id} className="flex flex-col-reverse px-2 py-1.5 text-center">
      <dt className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">{label}</dt>
      <dd className="flex items-center justify-center gap-0.5 text-sm font-semibold text-zinc-900 tabular dark:text-zinc-50">
        {flame ? <Flame size={12} aria-hidden className="text-orange-500" /> : null}
        {value}
      </dd>
    </div>
  );
}

const WATCH_STREAK_STATUS = {
  pending: { key: "watchStreakPending", tone: "outline" },
  watching: { key: "watchStreakWatching", tone: "accent" },
  credited: { key: "watchStreakCredited", tone: "live" },
  not_confirmed: { key: "watchStreakNotConfirmed", tone: "warning" },
  playback_failed: { key: "watchStreakPlaybackFailed", tone: "warning" },
  unavailable: { key: "watchStreakUnavailable", tone: "muted" },
} as const satisfies Record<
  WatchStreakRowStatus,
  { key: string; tone: "outline" | "accent" | "live" | "warning" | "muted" }
>;

function WatchStreakStatus({ status }: { status: WatchStreakRowStatus }): React.ReactElement {
  const t = useT();
  const { key, tone } = WATCH_STREAK_STATUS[status];
  return (
    <span data-watchlist-streak-status={status} className="flex">
      <Pill tone={tone}>{t(key)}</Pill>
    </span>
  );
}

/** The flame switch that opts a Watchlist channel in or out of streaks. */
export function WatchStreakToggle({
  name,
  enabled,
  onToggle,
}: {
  name: string;
  enabled: boolean;
  onToggle(enabled: boolean): void;
}): React.ReactElement {
  const t = useT();
  const label = t("watchlistStreakToggle", name);
  return (
    <Tip label={label}>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        data-watchlist-streak-toggle
        onClick={(event) => {
          event.stopPropagation();
          onToggle(!enabled);
        }}
        className={
          enabled
            ? "flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-orange-500/12 text-orange-600 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:text-orange-400"
            : "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors outline-none hover:bg-zinc-100 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        }
      >
        <Flame size={13} aria-hidden />
      </button>
    </Tip>
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
        style={{ gridTemplateRows: "auto repeat(7, 15px)" }}
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
                className="h-3 w-[15px] overflow-visible text-[9px] leading-3 whitespace-nowrap text-zinc-400 dark:text-zinc-500"
              >
                {label}
              </span>
              {week.map((key) => {
                if (key > today) return <span key={key} aria-hidden className="size-[15px]" />;
                const count = credited[key] ?? 0;
                return (
                  <Tip key={key} label={describe(key, count)}>
                    <span
                      data-day={key}
                      data-count={count}
                      className={cn(
                        "size-[15px] rounded-[3px]",
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
  onToggle,
}: {
  channel: string;
  days: Readonly<Record<string, WatchStreakDayOutcome>> | undefined;
  status: WatchStreakRowStatus | undefined;
  today: string;
  formatDay(key: string): string;
  formatNumber(value: number): string;
  onToggle?(enabled: boolean): void;
}): React.ReactElement {
  const t = useT();
  const { run, atRisk } = channelStreakRun(days);
  const strip = Array.from({ length: STRIP_DAYS }, (_, index) =>
    shiftDayKey(today, index - (STRIP_DAYS - 1)),
  );
  const watching = status === "watching";
  return (
    <li data-watch-streak-channel={channel} className="flex items-center gap-2 py-1.5">
      <span className="flex w-28 shrink-0 flex-col items-start gap-0.5">
        <span
          className={cn(
            "max-w-full truncate text-[11px] font-medium",
            atRisk ? "text-rose-600 dark:text-rose-400" : "text-zinc-700 dark:text-zinc-200",
          )}
        >
          {channel}
        </span>
        <WatchStreakStatus status={status ?? "pending"} />
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
      {onToggle ? <WatchStreakToggle name={channel} enabled onToggle={onToggle} /> : null}
    </li>
  );
}
