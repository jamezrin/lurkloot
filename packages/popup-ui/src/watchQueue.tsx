import React, { useState } from "react";
import { DndContext, DragOverlay, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus } from "lucide-react";
import type { Platform } from "@lurkloot/shared/models";
import { useT } from "./context";
import { formatViewers } from "./format";
import type { StreamerItem } from "./types";
import {
  CompactRow,
  DragHandle,
  EmptyPanel,
  Pill,
  RemoveRowButton,
  moveById,
  useDndSensors,
} from "./primitives";

export function WatchQueuePanel({ streamers, onChange }: { platform: Platform; streamers: StreamerItem[]; onChange(streamers: StreamerItem[]): void | Promise<void> }) {
  const t = useT();
  const sensors = useDndSensors();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
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
      setAdding(false);
      return;
    }
    void onChange([...streamers, { id: username, name: username, live: false }]);
    setValue("");
    setAdding(false);
  }

  function removeChannel(id: string): void {
    void onChange(streamers.filter((streamer) => streamer.id !== id));
  }

  return (
    <div className="space-y-2.5">
      {streamers.length === 0 ? <EmptyPanel>{t("noWatchQueue")}</EmptyPanel> : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(event) => setActiveId(String(event.active.id))} onDragEnd={endDrag} onDragCancel={() => setActiveId(null)}>
          <SortableContext items={streamers.map((streamer) => streamer.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1.5">
              {streamers.map((streamer, index) => <SortableWatchQueue key={streamer.id} streamer={streamer} index={index} onRemove={() => removeChannel(streamer.id)} />)}
            </div>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {active ? <CompactRow isOverlay index={activeIndex} avatar={active.name.slice(0, 2).toUpperCase()} avatarStyle={{ backgroundColor: "var(--accent-soft)", color: "var(--accent-text)" }} title={active.name} subtitle={active.subtitle} dragHandle={<GripVertical size={16} className="text-zinc-400" />} trailing={<WatchQueueStatus streamer={active} />} /> : null}
          </DragOverlay>
        </DndContext>
      )}
      {adding ? (
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); addChannel(); }}>
          <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder={t("channelPlaceholder")} className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-medium text-zinc-900 outline-none focus:border-[var(--accent-ring)] dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100" />
          <button type="submit" className="rounded-xl bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--accent-contrast)]">{t("add")}</button>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 py-2 text-xs font-medium text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200">
          <Plus size={14} /> {t("addChannel")}
        </button>
      )}
    </div>
  );
}

function SortableWatchQueue({ streamer, index, onRemove }: { streamer: StreamerItem; index: number; onRemove(): void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: streamer.id });
  const status = <WatchQueueStatus streamer={streamer} />;
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <CompactRow index={index} avatar={streamer.name.slice(0, 2).toUpperCase()} avatarStyle={{ backgroundColor: "var(--accent-soft)", color: "var(--accent-text)" }} title={streamer.name} subtitle={streamer.subtitle} dimmed={isDragging} dragHandle={<DragHandle setActivatorNodeRef={setActivatorNodeRef} attributes={attributes} listeners={listeners} label={`Reorder ${streamer.name}`} />} trailing={<span className="flex shrink-0 items-center gap-1.5">{status}<RemoveRowButton label={`Remove ${streamer.name}`} onClick={onRemove} /></span>} />
    </div>
  );
}

function WatchQueueStatus({ streamer }: { streamer: StreamerItem }): React.ReactElement {
  const t = useT();
  if (streamer.live) {
    return <Pill tone="live"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{streamer.viewers != null ? formatViewers(streamer.viewers) : t("live")}</Pill>;
  }
  return <Pill tone="muted">{t("queued")}</Pill>;
}
