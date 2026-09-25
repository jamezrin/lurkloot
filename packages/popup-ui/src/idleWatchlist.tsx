import React, { useState } from "react";
import { arrayMove } from "@dnd-kit/helpers";
import { DragDropProvider } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { Eye, Plus } from "lucide-react";
import type { Platform, WatchSourceId } from "@lurkloot/shared/models";
import { IDLE_WATCHLIST_LIMIT } from "@lurkloot/shared/settings";
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
  const link = /^(?:https?:\/\/)?(?:www\.|m\.)?(?:twitch\.tv|kick\.com)\/(?:@)?([^/?#\s]+)/i.exec(trimmed);
  const name = (link ? link[1]! : trimmed.replace(/^@/, "")).toLowerCase();
  return /^[a-z0-9_-]+$/.test(name) ? name : undefined;
}

/** The Idle Watchlist destination. The add field sits at the top, always
 * open, with where the list falls in the watch order right under it, so
 * nothing about the list waits at the bottom of a long page. */
export function IdleWatchlistPanel({ platform, streamers, watchOrder, onChangeOrder, onChange }: {
  platform: Platform;
  streamers: StreamerItem[];
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
      if (value.trim()) setNotice(t("idleWatchlistInvalid"));
      return;
    }
    if (streamers.some((streamer) => streamer.name.toLowerCase() === username)) {
      setNotice(t("idleWatchlistDuplicate", username));
      return;
    }
    void onChange([...streamers, { id: username, name: username, live: false }]);
    setValue("");
    setNotice(undefined);
  }

  return (
    <section id="idle-watchlist" className="space-y-2">
      <ViewToolbar>
        <span data-watchlist-count className="font-mono text-[11px] text-zinc-400 tabular dark:text-zinc-500">
          {streamers.length}/{IDLE_WATCHLIST_LIMIT}
        </span>
      </ViewToolbar>

      <form className="space-y-1" onSubmit={(event) => { event.preventDefault(); addChannel(); }}>
        <div className="flex gap-2">
          <input
            data-watchlist-input
            value={value}
            disabled={full}
            aria-label={t("addChannel")}
            onChange={(event) => { setValue(event.target.value); setNotice(undefined); }}
            placeholder={t(full ? "idleWatchlistFull" : "idleWatchlistAddPlaceholder", String(IDLE_WATCHLIST_LIMIT))}
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
        {notice ? <p role="status" data-watchlist-notice className="px-1 text-[11px] text-amber-600 dark:text-amber-400">{notice}</p> : null}
      </form>

      {watchOrder && onChangeOrder ? (
        <WatchSourcePlace source="idle_watchlist" order={watchOrder} onChangeOrder={onChangeOrder} />
      ) : null}

      {streamers.length === 0 ? <EmptyPanel>{t("noIdleWatchlist")}</EmptyPanel> : (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{t("idleWatchlistOrderTitle")}</span>
            <span className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">{t("idleWatchlistOrderHint")}</span>
            <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          </div>
          <DragDropProvider onDragEnd={endDrag}>
            <div className="space-y-1.5">
              {streamers.map((streamer, index) => (
                <SortableIdleWatchlist
                  key={streamer.id}
                  streamer={streamer}
                  index={index}
                  count={streamers.length}
                  platform={platform}
                  onRemove={() => void onChange(streamers.filter((entry) => entry.id !== streamer.id))}
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

function SortableIdleWatchlist({ streamer, index, count, platform, onRemove, onMove }: { streamer: StreamerItem; index: number; count: number; platform: Platform; onRemove(): void; onMove(toIndex: number): void }) {
  // The new dnd-kit animates the real element, so there is no DragOverlay copy
  // and no transform/transition to apply by hand.
  const t = useT();
  const { ref, handleRef, isDragging } = useSortable({ id: streamer.id, index });
  const status = <IdleWatchlistStatus streamer={streamer} />;
  return (
    <div ref={ref} onDragStart={preventNativeDrag}>
      <CompactRow index={index} rankCount={count} rankLabel={streamer.name} onRankMove={onMove} avatar={streamer.name.slice(0, 2).toUpperCase()} avatarStyle={{ backgroundColor: "var(--accent-soft)", color: "var(--accent-text)" }} title={streamer.name} titleHref={channelUrl(platform, streamer.id)} subtitle={streamer.subtitle} dimmed={isDragging} dragHandle={<DragHandle handleRef={handleRef} label={t("reorderItem", streamer.name)} />} trailing={<span className="flex shrink-0 items-center gap-1.5">{status}<RemoveRowButton label={t("removeItem", streamer.name)} onClick={onRemove} /></span>} />
    </div>
  );
}

function IdleWatchlistStatus({ streamer }: { streamer: StreamerItem }): React.ReactElement {
  const t = useT();
  if (streamer.live) {
    // Same eye-plus-count grammar (and same accessible label) the status line
    // uses, so a bare number means viewers wherever it appears.
    const viewers = streamer.viewers != null ? t("viewerCount", formatViewers(streamer.viewers)) : undefined;
    return (
      <Tip label={viewers}>
        <span role={viewers ? "img" : undefined} aria-label={viewers}>
          <Pill tone="live">
            {streamer.viewers != null ? <><Eye size={9} aria-hidden />{formatViewers(streamer.viewers)}</> : t("live")}
          </Pill>
        </span>
      </Tip>
    );
  }
  return <></>;
}
