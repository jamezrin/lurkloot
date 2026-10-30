import type React from "react";
import { useState } from "react";
import { arrayMove } from "@dnd-kit/helpers";
import { DragDropProvider } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { Eye, Flame, Plus } from "lucide-react";
import type { Platform, WatchSourceId, WatchStreakRowStatus } from "@lurkloot/shared/models";
import { IDLE_WATCHLIST_LIMIT, WATCH_STREAK_BUDGET_MINUTES } from "@lurkloot/shared/settings";
import { useT } from "./context";
import { formatViewers } from "./format";
import { channelUrl } from "./viewModels";
import type { StreamerItem } from "./types";
import {
  CompactRow,
  DragHandle,
  EmptyPanel,
  Pill,
  RemoveRowButton,
  reorderFromDragEnd,
  preventNativeDrag,
  type SortableDragEndEvent,
} from "./primitives";
import { Tip } from "./tooltip";
import { ViewToolbar } from "./viewToolbar";
import { WatchSourcePlace } from "./watchSourcePriority";

/** The channel name in what the user typed or pasted: a bare name, an @name, or
 * a channel link on either platform. Undefined when nothing usable is left. */
export function channelNameFromInput(value: string): string | undefined {
  const trimmed = value.trim();
  const link = /^(?:https?:\/\/)?(?:www\.|m\.)?(?:twitch\.tv|kick\.com)\/(?:@)?([^/?#\s]+)/i.exec(
    trimmed,
  );
  const name = (link ? link[1]! : trimmed.replace(/^@/, "")).toLowerCase();
  return /^[a-z0-9_-]+$/.test(name) ? name : undefined;
}

/** Watch-streak maintenance on the rows (#897). Only offered where the
 * platform maintains streaks (Twitch). */
export interface IdleWatchlistStreaks {
  // Rows the user opted in, lowercased.
  enabled: ReadonlySet<string>;
  // The last tick's status per opted-in row.
  statuses: Readonly<Record<string, WatchStreakRowStatus>>;
  onToggle(username: string, enabled: boolean): void;
}

/** The Watchlist destination. The add field sits at the top, always
 * open, with where the list falls in the watch order right under it, so
 * nothing about the list waits at the bottom of a long page. */
export function IdleWatchlistPanel({
  platform,
  streamers,
  watchOrder,
  onChangeOrder,
  onChange,
  streaks,
}: {
  platform: Platform;
  streamers: StreamerItem[];
  streaks?: IdleWatchlistStreaks;
  // The platform's watch-source priority, which decides when the list is used.
  watchOrder?: readonly WatchSourceId[];
  onChangeOrder?(): void;
  onChange(streamers: StreamerItem[]): void | Promise<void>;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const [notice, setNotice] = useState<string | undefined>();
  const full = streamers.length >= IDLE_WATCHLIST_LIMIT;

  function endDrag(event: SortableDragEndEvent): void {
    const next = reorderFromDragEnd(streamers, event);
    if (next === streamers) return;
    void onChange(next);
  }

  function addChannel(): void {
    const username = channelNameFromInput(value);
    if (!username) {
      if (value.trim()) setNotice(t("watchlistInvalid"));
      return;
    }
    if (streamers.some((streamer) => streamer.name.toLowerCase() === username)) {
      setNotice(t("watchlistDuplicate", username));
      return;
    }
    void onChange([...streamers, { id: username, name: username, live: false }]);
    setValue("");
    setNotice(undefined);
  }

  return (
    <section id="idle-watchlist" className="space-y-2">
      <ViewToolbar>
        <span
          data-watchlist-count
          className="font-mono text-[11px] text-zinc-400 tabular dark:text-zinc-500"
        >
          {streamers.length}/{IDLE_WATCHLIST_LIMIT}
        </span>
      </ViewToolbar>

      <form
        className="space-y-1"
        onSubmit={(event) => {
          event.preventDefault();
          addChannel();
        }}
      >
        <div className="flex gap-2">
          <input
            data-watchlist-input
            value={value}
            disabled={full}
            aria-label={t("addChannel")}
            onChange={(event) => {
              setValue(event.target.value);
              setNotice(undefined);
            }}
            placeholder={t(
              full ? "watchlistFull" : "watchlistAddPlaceholder",
              String(IDLE_WATCHLIST_LIMIT),
            )}
            className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-[var(--accent-ring)] disabled:cursor-not-allowed disabled:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:disabled:bg-zinc-900/50"
          />
          <button
            type="submit"
            data-watchlist-add
            disabled={full || !value.trim()}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[var(--ink)] px-3 text-xs font-semibold text-[var(--ink-contrast)] disabled:opacity-40"
          >
            <Plus size={13} aria-hidden /> {t("add")}
          </button>
        </div>
        {notice ? (
          <p
            role="status"
            data-watchlist-notice
            className="px-1 text-[11px] text-amber-600 dark:text-amber-400"
          >
            {notice}
          </p>
        ) : null}
      </form>

      {watchOrder && onChangeOrder ? (
        <WatchSourcePlace
          source="watchlist"
          order={watchOrder}
          onChangeOrder={onChangeOrder}
          named={Boolean(streaks && streaks.enabled.size > 0)}
        />
      ) : null}

      {watchOrder && onChangeOrder && streaks && streaks.enabled.size > 0 ? (
        <WatchSourcePlace
          source="watch_streaks"
          order={watchOrder}
          onChangeOrder={onChangeOrder}
          named
        />
      ) : null}

      {streamers.length === 0 ? (
        <EmptyPanel>{t("noWatchlist")}</EmptyPanel>
      ) : (
        <div data-tour="watchlist" className="space-y-1.5">
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
              {t("watchlistOrderTitle")}
            </span>
            <span className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">
              {t("watchlistOrderHint")}
            </span>
            <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          </div>
          {streaks ? (
            <p
              data-watchlist-streak-hint
              className="flex items-center gap-1 px-1 text-[10px] text-zinc-400 dark:text-zinc-500"
            >
              <Flame size={10} aria-hidden className="shrink-0 text-orange-500" />
              {t("watchlistStreakHint", String(WATCH_STREAK_BUDGET_MINUTES))}
            </p>
          ) : null}
          <DragDropProvider onDragEnd={endDrag}>
            <div className="space-y-1.5">
              {streamers.map((streamer, index) => (
                <SortableIdleWatchlist
                  key={streamer.id}
                  streamer={streamer}
                  index={index}
                  count={streamers.length}
                  platform={platform}
                  streak={
                    streaks
                      ? {
                          enabled: streaks.enabled.has(streamer.id.toLowerCase()),
                          status: streaks.statuses[streamer.id.toLowerCase()],
                          onToggle: (enabled) =>
                            streaks.onToggle(streamer.id.toLowerCase(), enabled),
                        }
                      : undefined
                  }
                  onRemove={() =>
                    void onChange(streamers.filter((entry) => entry.id !== streamer.id))
                  }
                  onMove={(toIndex) => void onChange(arrayMove(streamers, index, toIndex))}
                />
              ))}
            </div>
          </DragDropProvider>
        </div>
      )}
    </section>
  );
}

function SortableIdleWatchlist({
  streamer,
  index,
  count,
  platform,
  streak,
  onRemove,
  onMove,
}: {
  streamer: StreamerItem;
  index: number;
  count: number;
  platform: Platform;
  streak?: { enabled: boolean; status?: WatchStreakRowStatus; onToggle(enabled: boolean): void };
  onRemove(): void;
  onMove(toIndex: number): void;
}) {
  // The new dnd-kit animates the real element, so there is no DragOverlay copy
  // and no transform/transition to apply by hand.
  const t = useT();
  const { ref, handleRef, isDragging } = useSortable({ id: streamer.id, index });
  const status = <IdleWatchlistStatus streamer={streamer} />;
  return (
    <div ref={ref} onDragStart={preventNativeDrag}>
      <CompactRow
        index={index}
        rankCount={count}
        rankLabel={streamer.name}
        onRankMove={onMove}
        avatar={streamer.name.slice(0, 2).toUpperCase()}
        avatarStyle={{ backgroundColor: "var(--accent-soft)", color: "var(--accent-text)" }}
        title={streamer.name}
        titleHref={channelUrl(platform, streamer.id)}
        subtitle={streamer.subtitle}
        dimmed={isDragging}
        dragHandle={<DragHandle handleRef={handleRef} label={t("reorderItem", streamer.name)} />}
        trailing={
          <span className="flex shrink-0 items-center gap-1.5">
            {streak?.enabled ? <WatchStreakStatus status={streak.status ?? "pending"} /> : null}
            {status}
            {streak ? (
              <WatchStreakToggle
                name={streamer.name}
                enabled={streak.enabled}
                onToggle={streak.onToggle}
              />
            ) : null}
            <RemoveRowButton label={t("removeItem", streamer.name)} onClick={onRemove} />
          </span>
        }
      />
    </div>
  );
}

function IdleWatchlistStatus({ streamer }: { streamer: StreamerItem }): React.ReactElement {
  const t = useT();
  if (streamer.live) {
    // Same eye-plus-count grammar (and same accessible label) the status line
    // uses, so a bare number means viewers wherever it appears.
    const viewers =
      streamer.viewers != null ? t("viewerCount", formatViewers(streamer.viewers)) : undefined;
    return (
      <Tip label={viewers}>
        <span role={viewers ? "img" : undefined} aria-label={viewers}>
          <Pill tone="live">
            {streamer.viewers != null ? (
              <>
                <Eye size={9} aria-hidden />
                {formatViewers(streamer.viewers)}
              </>
            ) : (
              t("live")
            )}
          </Pill>
        </span>
      </Tip>
    );
  }
  return <></>;
}

function WatchStreakToggle({
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
    <span data-watchlist-streak-status={status}>
      <Pill tone={tone}>{t(key)}</Pill>
    </span>
  );
}
