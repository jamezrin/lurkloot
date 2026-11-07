import type React from "react";
import { useState, useSyncExternalStore } from "react";
import { NotInQueueSlotContext } from "./queue";
import { useT } from "./context";
import { ViewToolbarSlotContext } from "./viewToolbar";

// The viewport from which a window frame combines the drops views. Narrower,
// the window gets the popup's own layout: Queue, Completed and Games as
// separate views. A viewport query, not a container one, because it decides
// which rail entries exist, outside any one panel.
export const COMBINED_DROPS_MEDIA_QUERY = "(min-width: 1280px)";

function subscribeToCombinedDropsQuery(onChange: () => void): () => void {
  if (typeof matchMedia !== "function") return () => undefined;
  const query = matchMedia(COMBINED_DROPS_MEDIA_QUERY);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

function combinedDropsQueryMatches(): boolean {
  return typeof matchMedia === "function" && matchMedia(COMBINED_DROPS_MEDIA_QUERY).matches;
}

/** Whether the viewport is wide enough for the combined drops page. */
export function useCombinedDropsViewport(): boolean {
  return useSyncExternalStore(
    subscribeToCombinedDropsQuery,
    combinedDropsQueryMatches,
    () => false,
  );
}

/** The window frame's drops page: the queue in the main column, with Games
 * and Completed beside it instead of behind rail entries of their own.
 *
 * The page fills the window, which does not scroll: the queue and each
 * sidebar section scroll on their own, and the campaigns outside the queue
 * (action required, skipped, upcoming) stay in view below the queue's list, each a `data-scroll-panel` so
 * `scrollIntoPanel` moves the right one. A sidebar section is only as tall as
 * its content; when both overflow they share the height.
 *
 * Each scrolling region is its own `@container`, so a card in the sidebar
 * lays itself out for the sidebar's width, not the window's. The sidebar's
 * views get no toolbar slot: their controls stay inside their section, not in
 * the queue's title row. It is only shown from `COMBINED_DROPS_MEDIA_QUERY`
 * up. */
export function CombinedDropsPage({
  queue,
  games,
  completed,
  gamesCount,
  completedCount,
}: {
  queue: React.ReactNode;
  games: React.ReactNode;
  completed: React.ReactNode;
  gamesCount?: number;
  completedCount?: number;
}): React.ReactElement {
  const [notInQueueSlot, setNotInQueueSlot] = useState<HTMLElement | null>(null);
  return (
    <div
      data-drops-page
      className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_24rem] grid-rows-[minmax(0,1fr)] gap-x-5"
    >
      <div data-drops-column="queue" className="flex min-h-0 min-w-0 flex-col gap-3">
        <div
          data-scroll-panel
          className="nice-scroll @container -mr-2 min-h-0 flex-1 space-y-3 overflow-y-auto pr-2"
        >
          <NotInQueueSlotContext.Provider value={notInQueueSlot}>
            {queue}
          </NotInQueueSlotContext.Provider>
        </div>
        {/* The end of the queue stays in view below its list, scrolling on
        its own once its groups are open. Empty, it takes no room. */}
        <div
          ref={setNotInQueueSlot}
          data-scroll-panel
          data-queue-tail
          className="nice-scroll @container -mr-2 max-h-[45%] shrink-0 space-y-1 overflow-y-auto pr-2 empty:hidden"
        />
      </div>
      <aside className="flex min-h-0 min-w-0 flex-col gap-6">
        <DropsSection section="games" labelKey="navGames" count={gamesCount}>
          {games}
        </DropsSection>
        <DropsSection section="completed" labelKey="navCompleted" count={completedCount}>
          {completed}
        </DropsSection>
      </aside>
    </div>
  );
}

function DropsSection({
  section,
  labelKey,
  count,
  children,
}: {
  section: "games" | "completed";
  labelKey: string;
  count?: number;
  children: React.ReactNode;
}): React.ReactElement {
  const t = useT();
  const headingId = `drops-section-${section}`;
  return (
    // Grows from nothing and stops at its content's height, so a short list
    // leaves its space to the other section.
    <section
      data-drops-section={section}
      aria-labelledby={headingId}
      tabIndex={-1}
      className="flex max-h-fit min-h-0 min-w-0 flex-1 basis-0 flex-col gap-2 outline-none"
    >
      <h2
        id={headingId}
        className="font-display flex shrink-0 items-baseline gap-2 text-[13px] font-bold text-zinc-900 dark:text-zinc-50"
      >
        {t(labelKey)}
        {count !== undefined ? (
          <span className="tabular font-mono text-[10.5px] font-medium text-zinc-400">{count}</span>
        ) : null}
      </h2>
      <div
        data-scroll-panel
        className="nice-scroll @container -mr-2 min-h-0 flex-1 overflow-y-auto pr-2"
      >
        <ViewToolbarSlotContext.Provider value={null}>{children}</ViewToolbarSlotContext.Provider>
      </div>
    </section>
  );
}
