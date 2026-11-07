import type React from "react";
import { useT } from "./context";
import { ViewToolbarSlotContext } from "./viewToolbar";

/** The window frame's drops page: the queue in the main column, with Games
 * and Completed beside it instead of behind rail entries of their own.
 *
 * Each column is its own `@container`, so a card in the sidebar lays itself
 * out for the sidebar's width, not the window's. The sidebar's views get no
 * toolbar slot: their controls stay inside their section, not in the queue's
 * title row. Below 1000px of panel the sidebar drops under the queue. */
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
    <div
      data-drops-page
      className="@[1000px]:grid-cols-[minmax(0,1fr)_24rem] grid items-start gap-x-5 gap-y-6"
    >
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
