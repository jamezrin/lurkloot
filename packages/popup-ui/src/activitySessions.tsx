import React, { useState } from "react";
import { ChevronDown, ChevronRight, Coins, ExternalLink, Gift } from "lucide-react";
import type { ActivityHistoryRecord } from "@lurkloot/shared/events";
import type { FarmingSessionSummary, TallyEntry } from "@lurkloot/shared/farmingSessions";
import type { Platform } from "@lurkloot/shared/models";
import { EVENT_LEVEL_COLOR } from "./constants";
import { I18nContext, PopupRuntimeContext, useT } from "./context";
import { formatEventTime } from "./format";
import { openHttpsLink } from "./links";
import { ImageWithFallback, Pill } from "./primitives";
import {
  buildActivityTimeline,
  formatActivityEvent,
  groupTimelineByDay,
  type TimelineBlock,
} from "./activity.logic";
import { buildRewardView, type RewardView } from "./activityRewards";
import type { TFunction } from "./types";

const RARITY_BORDER: Record<string, string> = {
  common: "border-zinc-400",
  uncommon: "border-emerald-500",
  rare: "border-sky-500",
  epic: "border-violet-500",
  legendary: "border-amber-500",
  mythic: "border-rose-500",
};

const RARITY_TEXT: Record<string, string> = {
  common: "text-zinc-500",
  uncommon: "text-emerald-600 dark:text-emerald-400",
  rare: "text-sky-600 dark:text-sky-400",
  epic: "text-violet-600 dark:text-violet-400",
  legendary: "text-amber-600 dark:text-amber-400",
  mythic: "text-rose-600 dark:text-rose-400",
};

// A compact one-line activity row: status entries and the diagnostics view.
export function CompactActivityRow({
  event,
  ...props
}: { event: ActivityHistoryRecord } & React.HTMLAttributes<HTMLLIElement>): React.ReactElement {
  const t = useT();
  return (
    <li className="flex items-start gap-2 px-2.5 py-1.5 text-[11px] leading-snug" {...props}>
      <span
        className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: EVENT_LEVEL_COLOR[event.level] }}
      />
      <span className="shrink-0 font-mono text-[10px] text-zinc-400">
        {formatEventTime(event.at)}
      </span>
      <span className="min-w-0 break-words text-zinc-600 dark:text-zinc-300">
        {formatActivityEvent(event, t)}
      </span>
    </li>
  );
}

function formatClock(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDay(at: string): string {
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

function pointsTotal(summary: FarmingSessionSummary): number {
  return Object.values(summary.tallies).reduce((sum, tally) => sum + tally.total, 0);
}

function rewardTotal(summary: FarmingSessionSummary, rows: number): number {
  const counted = Object.values(summary.rewardCounts).reduce((sum, count) => sum + (count ?? 0), 0);
  return Math.max(counted, rows);
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

const REASON_KEYS: Record<string, string> = {
  WATCH: "pointsReasonWatch",
  WATCH_STREAK: "pointsReasonWatchStreak",
  RAID: "pointsReasonRaid",
};

function reasonLabel(reason: string, entry: { count: number; amount: number }, t: TFunction) {
  const amount = formatNumber(entry.amount);
  if (reason === "CLAIM") return `${t("pointsReasonClaim", String(entry.count))} · ${amount}`;
  const key = REASON_KEYS[reason];
  return `${key ? t(key) : reason} ${amount}`;
}

function Totals({ summary, rewards }: { summary: FarmingSessionSummary; rewards: number }) {
  const t = useT();
  const counts = summary.rewardCounts;
  const extension =
    (counts.extension_capture ?? 0)
    + (counts.extension_pack ?? 0)
    + (counts.extension_giveaway ?? 0);
  const tiles: Array<[number, string]> = [
    [pointsTotal(summary), "activityTotalPoints"],
    [counts.drop ?? 0, "activityTotalDrops"],
    [counts.challenge_card ?? 0, "activityTotalCards"],
    [extension, "activityTotalExtension"],
  ];
  const shown = tiles.filter(([value]) => value > 0);
  if (shown.length === 0 && rewards === 0) return null;
  return (
    <div className="mb-1.5 flex gap-1.5">
      {shown.map(([value, key]) => (
        <div key={key} className="flex-1 rounded-lg bg-zinc-100/80 px-2 py-1 dark:bg-zinc-800/70">
          <div className="text-[13px] font-bold tabular-nums text-zinc-800 dark:text-zinc-100">
            <bdi dir="ltr">
              {key === "activityTotalPoints" ? `+${formatNumber(value)}` : formatNumber(value)}
            </bdi>
          </div>
          <div className="text-[9.5px] text-zinc-500 dark:text-zinc-400">{t(key)}</div>
        </div>
      ))}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1 mt-2 text-[9.5px] font-semibold uppercase tracking-wide text-zinc-400">
      {children}
    </p>
  );
}

function RewardArt({ view }: { view: RewardView }) {
  // A drop without art shows its initial, like the reward lists; others a gift.
  const fallback =
    view.layout === "drop" ? (
      <span
        data-activity-reward-fallback
        role="img"
        aria-label={view.title}
        className="flex h-full w-full items-center justify-center text-sm font-bold text-[var(--accent-text)]"
      >
        {view.title.trim().charAt(0).toLocaleUpperCase() || "?"}
      </span>
    ) : (
      <span className="flex h-full w-full items-center justify-center text-[var(--accent-text)]">
        <Gift size={16} aria-hidden="true" />
      </span>
    );
  if (view.layout === "card") {
    return (
      <div
        className={`h-[42px] w-8 shrink-0 overflow-hidden rounded-md border-2 bg-zinc-100 dark:bg-zinc-800 ${RARITY_BORDER[view.rarity ?? ""] ?? "border-zinc-300 dark:border-zinc-600"}`}
      >
        <ImageWithFallback
          src={view.imageUrl}
          alt={view.title}
          fit="cover"
          fallback={fallback}
          zoom
        />
      </div>
    );
  }
  return (
    <div className="relative h-10 w-10 shrink-0">
      <div
        className={`h-10 w-10 overflow-hidden rounded-lg bg-[var(--accent-softer)] ${view.layout === "generic" && !view.imageUrl ? "border border-dashed border-zinc-300 dark:border-zinc-600" : ""}`}
      >
        <ImageWithFallback
          src={view.imageUrl}
          alt={view.title}
          fit="contain"
          className="p-0.5"
          fallback={fallback}
          zoom
        />
      </div>
      {view.overlayImageUrl ? (
        <div className="absolute -bottom-1 -end-1 h-5 w-[15px] overflow-hidden rounded-[3px] border border-white bg-zinc-200 dark:border-zinc-900">
          <ImageWithFallback src={view.overlayImageUrl} alt="" fit="cover" fallback={null} />
        </div>
      ) : null}
    </div>
  );
}

function RewardRow({ event }: { event: ActivityHistoryRecord }) {
  const t = useT();
  const runtime = React.useContext(PopupRuntimeContext);
  const view = buildRewardView(event, t);
  if (!view) return null;
  return (
    <li
      data-activity-reward-layout={view.layout}
      className="flex items-center gap-2 py-1 text-[11px] leading-snug"
    >
      <RewardArt view={view} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <p className="min-w-0 truncate font-semibold text-zinc-700 dark:text-zinc-200">
            {view.title}
          </p>
          <time className="ms-auto shrink-0 font-mono text-[10px] text-zinc-400">
            {formatClock(event.at)}
          </time>
        </div>
        {view.subtitle ? (
          <p className="truncate text-zinc-500 dark:text-zinc-400">{view.subtitle}</p>
        ) : null}
        {view.chips.length > 0 ? (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {view.chips.map((chip) => (
              <span
                key={chip.label}
                data-activity-chip={chip.label}
                className={chip.tone === "rarity" ? RARITY_TEXT[view.rarity ?? ""] : undefined}
              >
                <Pill tone={chip.tone === "highlight" ? "warning" : "muted"}>{chip.label}</Pill>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {view.linkUrl && runtime ? (
        <button
          type="button"
          aria-label={view.linkLabel ?? t("viewDropPage")}
          onClick={(clickEvent) => {
            clickEvent.stopPropagation();
            openHttpsLink(view.linkUrl!, runtime.adapter.openLink);
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 outline-none transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent-text)] focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
        >
          <ExternalLink size={13} aria-hidden="true" />
        </button>
      ) : null}
    </li>
  );
}

function PointsRow({ tally }: { tally: TallyEntry }) {
  const t = useT();
  const name =
    tally.subject.name ?? tally.subject.login ?? t("activityChannelId", tally.subject.id);
  const reasons = Object.entries(tally.breakdown).sort((a, b) => b[1].amount - a[1].amount);
  return (
    <li
      data-activity-points-channel={tally.subject.id}
      className="flex items-center gap-2 border-t border-zinc-200/70 py-1.5 text-[11px] first:border-t-0 dark:border-zinc-800"
    >
      <div className="h-[22px] w-[22px] shrink-0 overflow-hidden rounded-full bg-[var(--accent-softer)]">
        <ImageWithFallback
          src={tally.subject.imageUrl}
          alt=""
          fit="cover"
          fallback={
            <span className="flex h-full w-full items-center justify-center text-[10px] font-bold text-[var(--accent-text)]">
              {name.charAt(0).toLocaleUpperCase()}
            </span>
          }
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-zinc-700 dark:text-zinc-200">{name}</p>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {reasons.map(([reason, entry]) => (
            <span key={reason} data-points-reason={reason}>
              <Pill tone={reason === "WATCH_STREAK" ? "warning" : "muted"}>
                {reasonLabel(reason, entry, t)}
              </Pill>
            </span>
          ))}
        </div>
      </div>
      <span className="shrink-0 font-bold tabular-nums text-zinc-800 dark:text-zinc-100">
        <bdi dir="ltr">+{formatNumber(tally.total)}</bdi>
      </span>
    </li>
  );
}

function StatusSection({ rows }: { rows: ActivityHistoryRecord[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wide text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
      >
        <Chevron size={11} className="rtl:-scale-x-100" aria-hidden="true" />
        {t("activitySectionStatus", String(rows.length))}
      </button>
      {open ? (
        <ul className="mt-0.5">
          {rows.map((event) => (
            <CompactActivityRow key={event.id} event={event} data-activity-status-row={event.id} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function BlockBody({ block, summary }: { block: TimelineBlock; summary?: FarmingSessionSummary }) {
  const t = useT();
  const tallies = summary
    ? Object.values(summary.tallies).sort((left, right) => right.total - left.total)
    : [];
  const empty = block.rewards.length === 0 && tallies.length === 0;
  return (
    <>
      {summary && !empty ? <Totals summary={summary} rewards={block.rewards.length} /> : null}
      {empty ? (
        <p
          data-activity-session-empty
          className="py-1 text-[11px] text-zinc-500 dark:text-zinc-400"
        >
          {t("activitySessionEmpty")}
        </p>
      ) : null}
      {block.rewards.length > 0 ? (
        <>
          {/* Labelled only beside a session's points; elsewhere rewards are all there is. */}
          {summary ? <SectionLabel>{t("activitySectionRewards")}</SectionLabel> : null}
          <ul className="space-y-0.5">
            {block.rewards.map((event) => (
              <RewardRow key={event.id} event={event} />
            ))}
          </ul>
        </>
      ) : null}
      {tallies.length > 0 ? (
        <>
          <SectionLabel>{t("activitySectionPoints")}</SectionLabel>
          <ul>
            {tallies.map((tally) => (
              <PointsRow key={`${tally.kind}:${tally.subject.id}`} tally={tally} />
            ))}
          </ul>
        </>
      ) : null}
      <StatusSection rows={block.status} />
    </>
  );
}

const BLOCK_CARD = "rounded-xl bg-zinc-50/80 px-2.5 py-2 dark:bg-zinc-900/60";

// A session's times: the day is the section it is listed under, so only an
// end on a later day names that day.
function sessionTimes(summary: FarmingSessionSummary): string {
  const start = formatClock(summary.startedAt);
  if (!summary.endedAt) return start;
  const sameDay = formatDay(summary.startedAt) === formatDay(summary.endedAt);
  return `${start} – ${sameDay ? "" : `${formatDay(summary.endedAt)} `}${formatClock(summary.endedAt)}`;
}

function SessionBlock({ block }: { block: Extract<TimelineBlock, { type: "session" }> }) {
  const t = useT();
  const [expanded, setExpanded] = useState(block.open);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const summary = block.summary;
  return (
    <li data-activity-session={summary.id} className={BLOCK_CARD}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1.5 text-start"
      >
        <Chevron size={12} className="shrink-0 text-zinc-400 rtl:-scale-x-100" aria-hidden="true" />
        <span className="text-[11.5px] font-semibold text-zinc-700 dark:text-zinc-200">
          {block.open ? t("activitySessionCurrent") : sessionTimes(summary)}
        </span>
        <span className="ms-auto shrink-0 text-[10px] text-zinc-500 dark:text-zinc-400">
          {block.open ? (
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">
              ● {t("activitySessionLive", formatClock(summary.startedAt))}
            </span>
          ) : (
            <SessionCounts
              points={pointsTotal(summary)}
              rewards={rewardTotal(summary, block.rewards.length)}
            />
          )}
        </span>
      </button>
      {expanded ? (
        <div className="mt-1.5">
          <BlockBody block={block} summary={summary} />
        </div>
      ) : null}
    </li>
  );
}

// A past session's one-line totals: icons rather than words, so no count needs
// a plural, and a zero (points on Kick) is left out. The sentence stays as the
// accessible name.
function SessionCounts({ points, rewards }: { points: number; rewards: number }) {
  const t = useT();
  return (
    <span
      aria-label={t("activitySessionSummary", [formatNumber(points), String(rewards)])}
      className="inline-flex items-center gap-2 tabular-nums"
    >
      {points > 0 ? (
        <span data-session-points className="inline-flex items-center gap-0.5">
          <Coins size={11} aria-hidden="true" />
          <bdi dir="ltr">+{formatNumber(points)}</bdi>
        </span>
      ) : null}
      {rewards > 0 ? (
        <span data-session-rewards className="inline-flex items-center gap-0.5">
          <Gift size={11} aria-hidden="true" />
          {formatNumber(rewards)}
        </span>
      ) : null}
    </span>
  );
}

function OutsideBlock({ block }: { block: Extract<TimelineBlock, { type: "outside" }> }) {
  const t = useT();
  return (
    <li data-activity-block="outside" className={BLOCK_CARD}>
      <p className="text-[11.5px] font-semibold text-zinc-600 dark:text-zinc-300">
        {t("activitySessionOutside")}
      </p>
      <div className="mt-1">
        <BlockBody block={block} />
      </div>
    </li>
  );
}

// Rows stored before sessions existed: the day's rewards and status, drawn the
// same way, with no session heading.
function EarlierBlock({ block }: { block: Extract<TimelineBlock, { type: "earlier" }> }) {
  return (
    <li data-activity-block="earlier" className={BLOCK_CARD}>
      <BlockBody block={block} />
    </li>
  );
}

// "Today", "Yesterday" (from the browser's own relative-time wording), else
// the date.
function dayLabel(day: string, locale: string): string {
  const date = new Date(`${day}T12:00:00`);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const daysAgo = Math.round((today.getTime() - date.getTime()) / 86_400_000);
  if (daysAgo === 0 || daysAgo === 1) {
    const label = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-daysAgo, "day");
    return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1);
  }
  return date.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" });
}

// The Activity view: day sections, newest first, each holding that day's
// farming sessions, its rewards obtained outside a session, and rows stored
// before sessions existed.
export function ActivitySessionTimeline({
  sessions,
  events,
  platform,
}: {
  sessions: readonly FarmingSessionSummary[];
  events: readonly ActivityHistoryRecord[];
  platform: Platform;
}): React.ReactElement {
  const { locale } = React.useContext(I18nContext);
  const days = groupTimelineByDay(buildActivityTimeline(sessions, events, platform));
  return (
    <div className="space-y-3">
      {days.map(({ day, blocks }) => (
        <section key={day} data-activity-day={day}>
          <h3 className="mb-1 px-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
            {dayLabel(day, locale)}
          </h3>
          <ul className="space-y-1.5">
            {blocks.flatMap((block): React.ReactNode[] => {
              if (block.type === "session")
                return [<SessionBlock key={block.summary.id} block={block} />];
              if (block.type === "outside")
                return [<OutsideBlock key={`outside-${block.day}`} block={block} />];
              return [<EarlierBlock key={`earlier-${block.day}`} block={block} />];
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
