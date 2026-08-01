import React, { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { DndContext, DragOverlay, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Eye, GripVertical, Play, Plus } from "lucide-react";
import type { Platform } from "@lurkloot/shared/models";
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
  moveById,
  useDndSensors,
} from "./primitives";

/** The watchlist as a collapsible section under the drops list. Expansion and the
 * add form are controlled from the popup so the shared list toolbar can open
 * both — that toolbar is what replaced the Drops/Idle Watchlist tab pair. */
export function IdleWatchlistPanel({ platform, streamers, expanded, adding, onExpandedChange, onAddingChange, onChange }: { platform: Platform; streamers: StreamerItem[]; expanded: boolean; adding: boolean; onExpandedChange(expanded: boolean): void; onAddingChange(adding: boolean): void; onChange(streamers: StreamerItem[]): void | Promise<void> }) {
  const t = useT();
  const sensors = useDndSensors();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const active = streamers.find((streamer) => streamer.id === activeId);
  const activeIndex = streamers.findIndex((streamer) => streamer.id === activeId);

  function endDrag(event: DragEndEvent): void {
    setActiveId(null);
    const active = String(event.active.id);
    const over = event.over?.id == null ? undefined : String(event.over.id);
    if (!over || active === over) return;
    void onChange(moveById(streamers, active, over));
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

  return (
    <section className="space-y-1.5">
      <SectionHeader
        label={t("idleWatchlistTab")}
        count={`${streamers.length}/20`}
        icon={Play}
        expanded={expanded}
        onToggle={() => onExpandedChange(!expanded)}
        action={(
          <IconButton
            label={t("addChannel")}
            onClick={() => { onExpandedChange(true); onAddingChange(true); }}
          >
            <Plus size={15} />
          </IconButton>
        )}
      />
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div key="watchlist" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="space-y-1.5">
              {streamers.length === 0 ? <EmptyPanel>{t("noIdleWatchlist")}</EmptyPanel> : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(event) => setActiveId(String(event.active.id))} onDragEnd={endDrag} onDragCancel={() => setActiveId(null)}>
                  <SortableContext items={streamers.map((streamer) => streamer.id)} strategy={verticalListSortingStrategy}>
                    <div className="space-y-1.5">
                      {streamers.map((streamer, index) => <SortableIdleWatchlist key={streamer.id} streamer={streamer} index={index} platform={platform} onRemove={() => removeChannel(streamer.id)} />)}
                    </div>
                  </SortableContext>
                  <DragOverlay dropAnimation={null}>
                    {active ? <CompactRow isOverlay index={activeIndex} avatar={active.name.slice(0, 2).toUpperCase()} avatarStyle={{ backgroundColor: "var(--accent-soft)", color: "var(--accent-text)" }} title={active.name} titleHref={channelUrl(platform, active.id)} subtitle={active.subtitle} dragHandle={<GripVertical size={16} className="text-zinc-400" />} trailing={<IdleWatchlistStatus streamer={active} />} /> : null}
                  </DragOverlay>
                </DndContext>
              )}
              {adding ? (
                <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); addChannel(); }}>
                  <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} onBlur={() => { if (!value.trim()) onAddingChange(false); }} placeholder={t("channelPlaceholder")} className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 outline-none focus:border-[var(--accent-ring)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
                  <button type="submit" className="rounded-xl bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--accent-contrast)]">{t("add")}</button>
                </form>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

function SortableIdleWatchlist({ streamer, index, platform, onRemove }: { streamer: StreamerItem; index: number; platform: Platform; onRemove(): void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: streamer.id });
  const status = <IdleWatchlistStatus streamer={streamer} />;
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <CompactRow index={index} avatar={streamer.name.slice(0, 2).toUpperCase()} avatarStyle={{ backgroundColor: "var(--accent-soft)", color: "var(--accent-text)" }} title={streamer.name} titleHref={channelUrl(platform, streamer.id)} subtitle={streamer.subtitle} dimmed={isDragging} dragHandle={<DragHandle setActivatorNodeRef={setActivatorNodeRef} attributes={attributes} listeners={listeners} label={`Reorder ${streamer.name}`} />} trailing={<span className="flex shrink-0 items-center gap-1.5">{status}<RemoveRowButton label={`Remove ${streamer.name}`} onClick={onRemove} /></span>} />
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
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          {streamer.viewers != null ? <><Eye size={9} aria-hidden />{formatViewers(streamer.viewers)}</> : t("live")}
        </Pill>
      </span>
    );
  }
  return <Pill tone="muted">{t("idleWatchlistChannel")}</Pill>;
}
