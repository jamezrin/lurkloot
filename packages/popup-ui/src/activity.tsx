import { isActivityTimelineEvent } from "@lurkloot/shared/farmingSessions";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Check, Clipboard, Clock3, Download } from "lucide-react";
import type { ActivityHistoryRecord } from "@lurkloot/shared/events";
import type { FarmingSessionSummary } from "@lurkloot/shared/farmingSessions";
import type { Platform } from "@lurkloot/shared/models";
import { EVENT_LEVEL_COLOR, PLATFORMS } from "./constants";
import { useT } from "./context";
import { formatEventTime } from "./format";
import { Tabs } from "@base-ui/react/tabs";
import { SearchBox } from "./primitives";
import { buildActivityExport } from "./activity.logic";
import { ActivitySessionTimeline, CompactActivityRow } from "./activitySessions";

// How long the button stays in its confirmation state after a successful copy.
const COPY_FEEDBACK_MS = 2500;

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
  version,
  locale,
  searchQuery = "",
  onSearchQueryChange = () => undefined,
  searchingDiagnostics = false,
  onShowDiagnosticsChange,
  onLoadMore,
  onClear,
  writeClipboard,
  onExportAll,
  sessions = [],
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
  version: string;
  locale: string;
  searchQuery?: string;
  onSearchQueryChange?(query: string): void;
  searchingDiagnostics?: boolean;
  onShowDiagnosticsChange(show: boolean): void;
  onLoadMore(): void;
  onClear(): void;
  // Omitted by hosts without a clipboard (the site demo), which hides the copy
  // control rather than offering a button that can only fail.
  writeClipboard?(text: string): Promise<boolean>;
  onExportAll?(): Promise<number | undefined>;
  // The platform's farming sessions; the Activity view groups its rows by them.
  sessions?: readonly FarmingSessionSummary[];
}): React.ReactElement {
  const t = useT();
  const forPlatform = useMemo(
    () =>
      activityEvents.filter(
        (event) =>
          (!event.platform || event.platform === platform)
          && ("legacy" in event || isActivityTimelineEvent(event))
          && !(event.category === "activity" && event.code === "auth_health_changed"),
      ),
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
  const trimmedSearchQuery = searchQuery.trim();
  const errorCount = visible.filter((event) => event.level === "error").length;
  // The session timeline draws its own cards, so it sits without the list's frame.
  const showTimeline = !showDiagnostics && (visible.length > 0 || sessions.length > 0);
  const [copied, setCopied] = useState<number | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [exported, setExported] = useState<number | null>(null);
  const [exportFailed, setExportFailed] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Confirmation is transient, and it must not survive a switch between the two
  // views: "Copied 42 events" next to a different list is a lie.
  useEffect(() => {
    setCopied(null);
    setCopyFailed(false);
    setExported(null);
    setExportFailed(false);
  }, [showDiagnostics, platform]);

  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (exported === null) return;
    const timer = setTimeout(() => setExported(null), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [exported]);

  async function copyVisible(): Promise<void> {
    if (!writeClipboard) return;
    // Built and written inside the click gesture: navigator.clipboard in the
    // popup needs the user activation, and nothing here needs a permission.
    const text = buildActivityExport(
      {
        events: visible,
        platform,
        diagnostics: showDiagnostics,
        version,
        userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
        locale,
        at: new Date().toISOString(),
      },
      t,
    );
    const ok = await writeClipboard(text);
    setCopyFailed(!ok);
    setCopied(ok ? visible.length : null);
  }

  async function exportAll(): Promise<void> {
    if (!onExportAll || exporting) return;
    setExporting(true);
    setExportFailed(false);
    setCopied(null);
    try {
      const count = await onExportAll();
      setExported(count ?? null);
    } catch {
      setExportFailed(true);
      setExported(null);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between px-0.5">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
          <Clock3 size={13} className="text-zinc-400" />
          {t(
            showDiagnostics ? "platformDiagnostics" : "platformActivity",
            PLATFORMS[platform].label,
          )}
          {errorCount > 0 ? (
            <span
              role="status"
              className="rounded-full px-1.5 py-0.5 text-[9px] font-bold text-white"
              style={{ backgroundColor: EVENT_LEVEL_COLOR.error }}
            >
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
          <Tabs.Root
            value={showDiagnostics ? "diagnostics" : "activity"}
            onValueChange={(value) => onShowDiagnosticsChange(value === "diagnostics")}
          >
            <Tabs.List
              activateOnFocus
              className="flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-zinc-100/70 p-0.5 dark:border-zinc-800 dark:bg-black/30"
            >
              {(["activity", "diagnostics"] as const).map((value) => (
                <Tabs.Tab
                  key={value}
                  value={value}
                  data-activity-view-tab={value}
                  className="rounded-md px-2 py-0.5 text-[9px] font-semibold text-zinc-400 outline-none transition not-data-[active]:hover:text-zinc-600 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] data-[active]:bg-[var(--ink)] data-[active]:text-[var(--ink-contrast)] dark:not-data-[active]:hover:text-zinc-200"
                >
                  {t(value === "diagnostics" ? "diagnosticsViewTab" : "activityViewTab")}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.Root>
        ) : null}
        {writeClipboard ? (
          <button
            type="button"
            onClick={() => void copyVisible()}
            disabled={visible.length === 0}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold transition disabled:opacity-50 ${copied === null ? "border-zinc-200 text-zinc-400 dark:border-zinc-700" : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"}`}
          >
            {copied === null ? <Clipboard size={10} /> : <Check size={10} />}
            {copied === null
              ? t(showDiagnostics ? "copyLoadedActivityLog" : "copyActivityLog")
              : t("copyActivityLogCopied", String(copied))}
          </button>
        ) : null}
        {showDiagnostics && onExportAll ? (
          <button
            type="button"
            onClick={() => void exportAll()}
            disabled={exporting}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold transition disabled:opacity-50 ${exported === null ? "border-zinc-200 text-zinc-400 dark:border-zinc-700" : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"}`}
          >
            {exported === null ? <Download size={10} /> : <Check size={10} />}
            {exported === null
              ? t("exportAllDiagnostics")
              : t("exportAllDiagnosticsDone", String(exported))}
          </button>
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
        <p role="alert" className="px-0.5 text-[10px] font-medium text-red-500">
          {t("clearActivityFailed")}
        </p>
      ) : null}
      {copyFailed ? (
        <p role="alert" className="px-0.5 text-[10px] font-medium text-red-500">
          {t("copyActivityLogFailed")}
        </p>
      ) : null}
      {exportFailed ? (
        <p role="alert" className="px-0.5 text-[10px] font-medium text-red-500">
          {t("exportAllDiagnosticsFailed")}
        </p>
      ) : null}
      {showDiagnostics ? (
        <SearchBox
          compact
          value={searchQuery}
          onChange={onSearchQueryChange}
          placeholder={t("searchDiagnostics")}
        />
      ) : null}
      <div
        data-tour="activity-list"
        className={
          showTimeline
            ? undefined
            : "overflow-hidden rounded-xl border border-zinc-200/70 bg-white/70 dark:border-zinc-800 dark:bg-zinc-900/50"
        }
      >
        {showTimeline ? (
          <ActivitySessionTimeline sessions={sessions} events={visible} platform={platform} />
        ) : visible.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-[11px] text-zinc-400">
            {showDiagnostics && searchingDiagnostics && trimmedSearchQuery
              ? t("noDiagnosticsMatch", trimmedSearchQuery)
              : t(showDiagnostics ? "noDiagnostics" : "noActivity")}
          </p>
        ) : (
          <ul className="space-y-1 p-1">
            {visible.map((event) => (
              <CompactActivityRow key={event.id} event={event} />
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
