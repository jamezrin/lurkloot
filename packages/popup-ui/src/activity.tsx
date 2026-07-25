import React, { useMemo } from "react";
import { Clock3 } from "lucide-react";
import type { ActivityHistoryRecord } from "@lurkloot/shared/events";
import type { Platform } from "@lurkloot/shared/models";
import { EVENT_LEVEL_COLOR, PLATFORMS } from "./constants";
import { useT } from "./context";
import { formatEventTime } from "./format";
import { formatActivityEvent } from "./activity.logic";

export function ActivityLog({
  activityEvents,
  diagnosticEvents,
  platform,
  lastTickAt,
  diagnosticLogging,
  showDiagnostics,
  hasMore,
  clearArmed,
  clearFailed,
  loadingMore,
  clearing,
  onShowDiagnosticsChange,
  onLoadMore,
  onClear,
}: {
  activityEvents: ActivityHistoryRecord[];
  diagnosticEvents: ActivityHistoryRecord[];
  platform: Platform;
  lastTickAt?: string;
  diagnosticLogging: boolean;
  showDiagnostics: boolean;
  hasMore: boolean;
  clearArmed: boolean;
  clearFailed: boolean;
  loadingMore: boolean;
  clearing: boolean;
  onShowDiagnosticsChange(show: boolean): void;
  onLoadMore(): void;
  onClear(): void;
}): React.ReactElement {
  const t = useT();
  const forPlatform = useMemo(
    () => activityEvents.filter((event) => !event.platform || event.platform === platform),
    [activityEvents, platform],
  );
  const diagnosticsForPlatform = useMemo(
    () => diagnosticEvents.filter((event) => !event.platform || event.platform === platform),
    [diagnosticEvents, platform],
  );
  // The toggle switches between two views instead of interleaving them: every
  // activity entry now has a diagnostic counterpart, so a merged list showed the
  // same thing twice and buried the high-level story in plumbing detail.
  const visible = showDiagnostics ? diagnosticsForPlatform : forPlatform;
  const errorCount = visible.filter((event) => event.level === "error").length;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between px-0.5">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
          <Clock3 size={13} className="text-zinc-400" />
          {t(showDiagnostics ? "platformDiagnostics" : "platformActivity", PLATFORMS[platform].label)}
          {errorCount > 0 ? (
            <span role="status" className="rounded-full px-1.5 py-0.5 text-[9px] font-bold text-white" style={{ backgroundColor: EVENT_LEVEL_COLOR.error }}>
              {errorCount}
            </span>
          ) : null}
        </span>
        <span className="text-[10px] font-medium text-zinc-400">
          {lastTickAt ? t("lastCheck", formatEventTime(lastTickAt)) : t("noChecksYet")}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {diagnosticLogging ? (
          <div role="tablist" className="flex items-center gap-0.5 rounded-full border border-zinc-200 p-0.5 dark:border-zinc-700">
            {([false, true] as const).map((diagnostics) => (
              <button
                key={String(diagnostics)}
                type="button"
                role="tab"
                aria-selected={showDiagnostics === diagnostics}
                onClick={() => onShowDiagnosticsChange(diagnostics)}
                className={`rounded-full px-2 py-0.5 text-[9px] font-semibold transition ${showDiagnostics === diagnostics ? "bg-zinc-600 text-white" : "text-zinc-400"}`}
              >
                {t(diagnostics ? "diagnosticsViewTab" : "activityViewTab")}
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          onClick={onClear}
          disabled={clearing}
          className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold transition disabled:opacity-50 ${clearArmed ? "border-red-300 bg-red-50 text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" : "border-zinc-200 text-zinc-400 dark:border-zinc-700"}`}
        >
          {t(clearArmed ? "confirmClearActivityHistory" : "clearActivityHistory")}
        </button>
      </div>
      {clearFailed ? (
        <p role="alert" className="px-0.5 text-[10px] font-medium text-red-500">{t("clearActivityFailed")}</p>
      ) : null}
      <div className="overflow-hidden rounded-xl border border-zinc-200/70 bg-white/70 dark:border-zinc-800 dark:bg-zinc-900/50">
        {visible.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-[11px] text-zinc-400">{t(showDiagnostics ? "noDiagnostics" : "noActivity")}</p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {visible.map((event) => (
              <li key={event.id} className="flex items-start gap-2 px-2.5 py-1.5 text-[11px] leading-snug">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: EVENT_LEVEL_COLOR[event.level] }} />
                <span className="shrink-0 font-mono text-[10px] text-zinc-400">{formatEventTime(event.at)}</span>
                <span className="min-w-0 break-words text-zinc-600 dark:text-zinc-300">{formatActivityEvent(event, t)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {hasMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-[10px] font-semibold text-zinc-500 transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900"
        >
          {t("loadMoreActivity")}
        </button>
      ) : null}
    </div>
  );
}
