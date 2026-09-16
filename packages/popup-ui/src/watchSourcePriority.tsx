import React from "react";
import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import type { Platform, WatchSourceId } from "@lurkloot/shared/models";
import { DEFAULT_WATCH_SOURCE_PRIORITY, normalizeWatchSourcePriority } from "@lurkloot/shared/watchSources";
import { useT } from "./context";

export const WATCH_SOURCE_NAME_KEYS: Record<WatchSourceId, string> = {
  drops: "watchSourceDrops",
  nopixel: "watchSourceNoPixel",
  fortnite: "watchSourceFortnite",
  idle_watchlist: "watchSourceIdleWatchlist",
};

export function WatchSourcePriority({ platform, value, onChange }: {
  platform: Platform;
  value: readonly WatchSourceId[];
  onChange(order: WatchSourceId[]): void | Promise<void>;
}) {
  const t = useT();
  const order = normalizeWatchSourcePriority(platform, value);
  const buttons = React.useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = React.useRef<{ source: WatchSourceId; direction: "up" | "down"; button: HTMLButtonElement } | undefined>(undefined);
  const [announcement, setAnnouncement] = React.useState("");

  React.useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = undefined;
    // Saving can finish after the user tabs to a different control. Only repair
    // focus if it stayed on the move button, or fell to the body on disabling it.
    if (document.activeElement !== pending.button && document.activeElement !== document.body) return;
    const button = buttons.current.get(`${pending.source}.${pending.direction}`);
    const opposite = buttons.current.get(`${pending.source}.${pending.direction === "up" ? "down" : "up"}`);
    (button?.disabled ? opposite : button)?.focus();
  }, [value]);

  const move = (source: WatchSourceId, offset: -1 | 1, button: HTMLButtonElement) => {
    const index = order.indexOf(source);
    const destination = index + offset;
    if (destination < 0 || destination >= order.length) return;
    const next = [...order];
    [next[index], next[destination]] = [next[destination], next[index]];
    if (document.activeElement === button) pendingFocus.current = { source, direction: offset === -1 ? "up" : "down", button };
    setAnnouncement(t("watchSourcePriorityMoved", [t(WATCH_SOURCE_NAME_KEYS[source]), String(destination + 1)]));
    void onChange(next);
  };

  const actionClass = "flex size-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-text)] disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-zinc-800 dark:hover:text-zinc-100";
  return (
    <div className="space-y-2">
      <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t("watchSourcePriorityDescription")}</p>
      <ol aria-label={t("watchSourcePriorityTitle")} className="list-none space-y-1.5">
        {order.map((source, index) => (
          <li key={source} data-watch-source={source} className="flex items-center gap-2 rounded-xl border border-zinc-200/70 px-2.5 py-1.5 dark:border-zinc-700/60">
            <span aria-hidden="true" className="w-4 shrink-0 text-center text-[11px] tabular-nums text-zinc-400">{index + 1}</span>
            <span className="min-w-0 flex-1 text-xs font-medium text-zinc-700 dark:text-zinc-200">{t(WATCH_SOURCE_NAME_KEYS[source])}</span>
            {(["up", "down"] as const).map((direction) => (
              <button
                key={direction}
                ref={(element) => {
                  const key = `${source}.${direction}`;
                  if (element) buttons.current.set(key, element);
                  else buttons.current.delete(key);
                }}
                type="button"
                aria-label={t(direction === "up" ? "watchSourcePriorityMoveUp" : "watchSourcePriorityMoveDown", t(WATCH_SOURCE_NAME_KEYS[source]))}
                disabled={direction === "up" ? index === 0 : index === order.length - 1}
                className={actionClass}
                onClick={(event) => move(source, direction === "up" ? -1 : 1, event.currentTarget)}
              >
                {direction === "up" ? <ArrowUp size={14} aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" />}
              </button>
            ))}
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-text)] dark:hover:bg-zinc-800"
        onClick={() => {
          setAnnouncement(t("watchSourcePriorityResetDone"));
          void onChange([...DEFAULT_WATCH_SOURCE_PRIORITY[platform]]);
        }}
      >
        <RotateCcw size={12} aria-hidden="true" />
        {t("watchSourcePriorityReset")}
      </button>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
    </div>
  );
}
