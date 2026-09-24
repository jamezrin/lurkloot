import React, { useState } from "react";
import { AnimatePresence } from "motion/react";
import { arrayMove } from "@dnd-kit/helpers";
import { DragDropProvider } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { Eye, Play, Plus } from "lucide-react";
import type { Platform } from "@lurkloot/shared/models";
import { IDLE_WATCHLIST_LIMIT } from "@lurkloot/shared/settings";
import { useT } from "./context";
import { formatViewers } from "./format";
import { channelUrl } from "./viewModels";
import type { StreamerItem } from "./types";
import {
  CompactRow,
  DragHandle,
  EmptyPanel,
  IconButton,
  Pill,
  RemoveRowButton,
  SectionHeader,
  reorderFromDragEnd,
  preventNativeDrag,
  type SortableDragEndEvent,
} from "./primitives";

/** The watchlist as a collapsible section under the drops list. Expansion and the
 * add form are controlled from the popup so the shared list toolbar can open
 * both — that toolbar is what replaced the Drops/Idle Watchlist tab pair. */
export function IdleWatchlistPanel({ platform, streamers, expanded, adding, bare = false, onExpandedChange, onAddingChange, onChange }: { platform: Platform; streamers: StreamerItem[]; expanded: boolean; adding: boolean; bare?: boolean; onExpandedChange(expanded: boolean): void; onAddingChange(adding: boolean): void; onChange(streamers: StreamerItem[]): void | Promise<void> }) {
  const t = useT();
  const [value, setValue] = useState("");

  function endDrag(event: SortableDragEndEvent): void {
    const next = reorderFromDragEnd(streamers, event);
    if (next === streamers) return;
    void onChange(next);
  }

  function addChannel(): void {
    const username = value.trim().replace(/^@/, "").toLowerCase();
    if (!username || streamers.some((streamer) => streamer.name.toLowerCase() === username)) {
      setValue("");
      onAddingChange(false);
      return;
    }
    void onChange([...streamers, { id: username, name: username, live: false }]);
    setValue("");
    onAddingChange(false);
  }

  function removeChannel(id: string): void {
    void onChange(streamers.filter((streamer) => streamer.id !== id));
  }

  const addButton = (
    <IconButton
      label={t("addChannel")}
      disabled={streamers.length >= IDLE_WATCHLIST_LIMIT}
      onClick={() => { onExpandedChange(true); onAddingChange(true); }}
    >
      <Plus size={15} />
    </IconButton>
  );

  return (
    <section id="idle-watchlist" className="space-y-1.5">
      {/* In its own destination the rail and the view title already name this
          list, so it drops its heading and keeps only what the heading carried
          that is not a repetition: the count and the add button. */}
      {bare ? (
        <div className="flex items-center justify-end gap-2 px-1">
          <span className="font-mono text-[11px] text-zinc-400 tabular dark:text-zinc-500">
            {streamers.length}/{IDLE_WATCHLIST_LIMIT}
          </span>
          {addButton}
        </div>
      ) : (
        <SectionHeader
          label={t("idleWatchlistTab")}
          count={`${streamers.length}/${IDLE_WATCHLIST_LIMIT}`}
          icon={Play}
          expanded={expanded}
          onToggle={() => onExpandedChange(!expanded)}
          action={addButton}
        />
      )}
      <AnimatePresence initial={false}>
        {expanded ? (
          <div key="watchlist" className="lurk-reveal">
            <div className="space-y-1.5">
              {streamers.length === 0 ? <EmptyPanel>{t("noIdleWatchlist")}</EmptyPanel> : (
                <DragDropProvider onDragEnd={endDrag}>
                  <div className="space-y-1.5">
                    {streamers.map((streamer, index) => (
                      <SortableIdleWatchlist
                        key={streamer.id}
                        streamer={streamer}
                        index={index}
                        count={streamers.length}
                        platform={platform}
                        onRemove={() => removeChannel(streamer.id)}
                        onMove={(toIndex) => void onChange(arrayMove(streamers, index, toIndex))}
                      />
                    ))}
                  </div>
                </DragDropProvider>
              )}
              {adding ? (
                <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); addChannel(); }}>
                  <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} onBlur={() => { if (!value.trim()) onAddingChange(false); }} placeholder={t("channelPlaceholder")} className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 outline-none focus:border-[var(--accent-ring)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
                  <button type="submit" className="rounded-lg bg-[var(--ink)] px-3 text-xs font-semibold text-[var(--ink-contrast)]">{t("add")}</button>
                </form>
              ) : null}
            </div>
          </div>
        ) : null}
      </AnimatePresence>
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
      <span role={viewers ? "img" : undefined} aria-label={viewers} title={viewers}>
        <Pill tone="live">
          {streamer.viewers != null ? <><Eye size={9} aria-hidden />{formatViewers(streamer.viewers)}</> : t("live")}
        </Pill>
      </span>
    );
  }
  return <></>;
}
