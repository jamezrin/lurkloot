import type React from "react";
import { useState, useSyncExternalStore } from "react";
import { NotInQueueSlotContext } from "./queue";
import { useT } from "./context";
import { cn } from "./primitives";
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

/** The window frame's drops page: Queue, Games and Completed as cards on one
 * page, instead of behind rail entries of their own.
 *
 * The page fills the window, which does not scroll: each card scrolls on its
 * own, each body a `data-scroll-panel` so `scrollIntoPanel` moves the right
 * one. The campaigns outside the queue (action required, skipped, upcoming)
 * stay in view at the foot of the Queue card, scrolling on their own past 45%
 * of it, and take no room when there are none.
 *
 * With room for it (the page's container from 72rem) the three cards stand
 * side by side, each the page's height. Narrower, Games and Completed stack
 * beside the Queue, each only as tall as its content, sharing the height when
 * both overflow.
 *
 * Each card body is its own `@container`, so a card lays its rows out for its
 * own width. Games and Completed put their toolbars (All/Selected,
 * Finished/Expired) in their card's header, not the page's title row. It is
 * only shown from `COMBINED_DROPS_MEDIA_QUERY` up. */
export function CombinedDropsPage({
  queue,
  games,
  completed,
  queueCount,
  gamesCount,
  completedCount,
}: {
  queue: React.ReactNode;
  games: React.ReactNode;
  completed: React.ReactNode;
  queueCount?: number;
  gamesCount?: number;
  completedCount?: number;
}): React.ReactElement {
  const [notInQueueSlot, setNotInQueueSlot] = useState<HTMLElement | null>(null);
  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div
        data-drops-page
        className="@6xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,1fr)] grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_22rem] grid-rows-[minmax(0,1fr)] gap-4"
      >
        <DropsCard
          section="queue"
          labelKey="navQueue"
          count={queueCount}
          footer={
            // The end of the queue stays in view below its list. Empty, it
            // takes no room.
            <div
              ref={setNotInQueueSlot}
              data-scroll-panel
              data-queue-tail
              className="nice-scroll @container max-h-[45%] shrink-0 space-y-1 overflow-y-auto border-t border-[var(--surface-edge)] bg-zinc-50/70 px-2.5 py-2 empty:hidden dark:bg-white/[0.02]"
            />
          }
        >
          <NotInQueueSlotContext.Provider value={notInQueueSlot}>
            <div className="space-y-3">{queue}</div>
          </NotInQueueSlotContext.Provider>
        </DropsCard>
        <div data-drops-aside className="@6xl:contents flex min-h-0 min-w-0 flex-col gap-4">
          <DropsCard section="games" labelKey="navGames" count={gamesCount} toolbar fitContent>
            {games}
          </DropsCard>
          <DropsCard
            section="completed"
            labelKey="navCompleted"
            count={completedCount}
            toolbar
            fitContent
          >
            {completed}
          </DropsCard>
        </div>
      </div>
    </div>
  );
}

function DropsCard({
  section,
  labelKey,
  count,
  toolbar = false,
  fitContent = false,
  footer,
  children,
}: {
  section: "queue" | "games" | "completed";
  labelKey: string;
  count?: number;
  // The card's header holds its view's toolbar.
  toolbar?: boolean;
  // Stacked, the card is only as tall as its content.
  fitContent?: boolean;
  footer?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  const t = useT();
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const headingId = `drops-section-${section}`;
  return (
    <section
      data-drops-section={section}
      aria-labelledby={headingId}
      tabIndex={-1}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--surface-edge)] bg-[var(--surface)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
        // Grows from nothing and stops at its content's height, so a short
        // list leaves its space to the card under it; side by side, every
        // card is the page's height.
        fitContent && "@6xl:max-h-none max-h-fit flex-1 basis-0",
      )}
    >
      <header className="flex min-h-[46px] shrink-0 items-center gap-2 border-b border-[var(--surface-edge)] px-3.5 py-2">
        <h2
          id={headingId}
          className="font-display flex shrink-0 items-baseline gap-2 text-[13px] font-bold text-zinc-900 dark:text-zinc-50"
        >
          {t(labelKey)}
          {count !== undefined ? (
            <span className="tabular font-mono text-[10.5px] font-medium text-zinc-400">
              {count}
            </span>
          ) : null}
        </h2>
        {toolbar ? (
          <div
            ref={setToolbarSlot}
            data-view-toolbar
            className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5"
          />
        ) : null}
      </header>
      <div
        data-scroll-panel
        className="nice-scroll @container min-h-0 flex-1 overflow-y-auto p-2.5"
      >
        <ViewToolbarSlotContext.Provider value={toolbarSlot}>
          {children}
        </ViewToolbarSlotContext.Provider>
      </div>
      {footer}
    </section>
  );
}
