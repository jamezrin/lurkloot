import React, { useEffect, useMemo, useState } from "react";
import { Clock3 } from "lucide-react";
import type { EventLogEntry, Platform } from "@stream-autopilot/shared/models";
import { LOG_LEVELS, type LogLevel } from "@stream-autopilot/shared/logging";
import { EVENT_LEVEL_COLOR, PLATFORMS } from "./constants";
import { useT } from "./context";
import { formatEventTime } from "./format";

export function ActivityLog({
  events,
  platform,
  lastTickAt,
  enabledLogLevels,
}: {
  events: EventLogEntry[];
  platform: Platform;
  lastTickAt?: string;
  enabledLogLevels: LogLevel[];
}): React.ReactElement {
  const t = useT();
  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(() => new Set(enabledLogLevels));
  useEffect(() => {
    setActiveLevels(new Set(enabledLogLevels));
  }, [enabledLogLevels.join(",")]);
  const forPlatform = useMemo(
    () => events.filter((event) => !event.platform || event.platform === platform),
    [events, platform],
  );
  const visible = useMemo(
    () => forPlatform.filter((event) => activeLevels.has(event.level)).slice(-80).reverse(),
    [forPlatform, activeLevels],
  );
  const errorCount = forPlatform.filter((event) => event.level === "error").length;
  const toggleLevel = (level: LogLevel) =>
    setActiveLevels((current) => {
      const next = new Set(current);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between px-0.5">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
          <Clock3 size={13} className="text-zinc-400" />
          {t("platformActivity", PLATFORMS[platform].label)}
          {errorCount > 0 ? (
            <span className="rounded-full px-1.5 py-0.5 text-[9px] font-bold text-white" style={{ backgroundColor: EVENT_LEVEL_COLOR.error }}>
              {errorCount}
            </span>
          ) : null}
        </span>
        <span className="text-[10px] font-medium text-zinc-400">
          {lastTickAt ? t("lastCheck", formatEventTime(lastTickAt)) : t("noChecksYet")}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1 px-0.5">
        {LOG_LEVELS.map((level) => {
          const active = activeLevels.has(level);
          return (
            <button
              key={level}
              type="button"
              onClick={() => toggleLevel(level)}
              className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold transition ${active
                ? "border-transparent text-white"
                : "border-zinc-200 text-zinc-400 dark:border-zinc-700"}`}
              style={active ? { backgroundColor: EVENT_LEVEL_COLOR[level] } : undefined}
              aria-pressed={active}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: active ? "#ffffff" : EVENT_LEVEL_COLOR[level] }} />
              {t(level)}
            </button>
          );
        })}
      </div>
      <div className="overflow-hidden rounded-xl border border-zinc-200/70 bg-white/70 dark:border-zinc-800 dark:bg-zinc-900/50">
        {visible.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-[11px] text-zinc-400">{t("noActivity")}</p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {visible.map((event) => (
              <li key={event.id} className="flex items-start gap-2 px-2.5 py-1.5 text-[11px] leading-snug">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: EVENT_LEVEL_COLOR[event.level] }} />
                <span className="shrink-0 font-mono text-[10px] text-zinc-400">{formatEventTime(event.at)}</span>
                <span className="min-w-0 break-words text-zinc-600 dark:text-zinc-300">{event.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
