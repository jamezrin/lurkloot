import type React from "react";
import { useSyncExternalStore } from "react";
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
 * Each column is its own `@container`, so a card in the sidebar lays itself
 * out for the sidebar's width, not the window's. The sidebar's views get no
 * toolbar slot: their controls stay inside their section, not in the queue's
 * title row. It is only shown from `COMBINED_DROPS_MEDIA_QUERY` up. */
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
  return (
    <div data-drops-page className="grid grid-cols-[minmax(0,1fr)_24rem] items-start gap-x-5">
      <div className="@container min-w-0 space-y-3">{queue}</div>
      <aside className="min-w-0 space-y-6">
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
    <section
      data-drops-section={section}
      aria-labelledby={headingId}
      className="@container min-w-0 scroll-mt-2 space-y-2"
    >
      <h2
        id={headingId}
        className="font-display flex items-baseline gap-2 text-[13px] font-bold text-zinc-900 dark:text-zinc-50"
      >
        {t(labelKey)}
        {count !== undefined ? (
          <span className="tabular font-mono text-[10.5px] font-medium text-zinc-400">{count}</span>
        ) : null}
      </h2>
      <ViewToolbarSlotContext.Provider value={null}>{children}</ViewToolbarSlotContext.Provider>
    </section>
  );
}
