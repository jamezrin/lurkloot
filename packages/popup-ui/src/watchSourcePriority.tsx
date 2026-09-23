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

/** One source's place in its platform's watch order, said in words: what has
 * to have nothing to watch before this source gets its turn. */
export function WatchSourcePlace({ source, order, onChangeOrder }: {
  source: WatchSourceId;
  order: readonly WatchSourceId[];
  onChangeOrder(): void;
}) {
  const t = useT();
  const index = order.indexOf(source);
  if (index === -1) return null;
  const before = order.slice(0, index).map((entry) => t(WATCH_SOURCE_NAME_KEYS[entry]));
  return (
    <div data-watch-source-place={source} className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-zinc-800 dark:text-zinc-100">{t("watchSourcePlace", [String(index + 1), String(order.length)])}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
          {before.length === 0 ? t("watchSourcePlaceFirst") : t("watchSourcePlaceAfter", before.join(", "))}
        </div>
      </div>
      <button type="button" onClick={onChangeOrder} className="shrink-0 rounded-full border border-zinc-200 px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-text)] hover:border-[var(--accent-ring)] dark:border-zinc-700">
        {t("watchSourceChangeOrderShort")}
      </button>
    </div>
  );
}
