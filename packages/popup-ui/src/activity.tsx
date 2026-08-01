import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clipboard,
  Clock3,
  ExternalLink,
  Gift,
  MonitorDown,
  MonitorUp,
  OctagonAlert,
  Pause,
  Play,
  RefreshCw,
  Shield,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import type { ActivityHistoryRecord } from "@lurkloot/shared/events";
import type { Platform } from "@lurkloot/shared/models";
import { EVENT_LEVEL_COLOR, PLATFORMS } from "./constants";
import { PopupRuntimeContext, useT } from "./context";
import { formatEventTime } from "./format";
import { openHttpsLink } from "./links";
import { ImageWithFallback, Pill } from "./primitives";
import {
  buildActivityCard,
  buildActivityExport,
  formatActivityEvent,
  type ActivityCardIcon,
  type ActivityCardTone,
} from "./activity.logic";

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
  onShowDiagnosticsChange,
  onLoadMore,
  onClear,
  writeClipboard,
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
  onShowDiagnosticsChange(show: boolean): void;
  onLoadMore(): void;
  onClear(): void;
  // Omitted by hosts without a clipboard (the site demo), which hides the copy
  // control rather than offering a button that can only fail.
  writeClipboard?(text: string): Promise<boolean>;
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
  const [copied, setCopied] = useState<number | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  // Confirmation is transient, and it must not survive a switch between the two
  // views: "Copied 42 events" next to a different list is a lie.
  useEffect(() => {
    setCopied(null);
    setCopyFailed(false);
  }, [showDiagnostics, platform]);

  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyVisible(): Promise<void> {
    if (!writeClipboard) return;
    // Built and written inside the click gesture: navigator.clipboard in the
    // popup needs the user activation, and nothing here needs a permission.
    const text = buildActivityExport({
      events: visible,
      platform,
      diagnostics: showDiagnostics,
      version,
      userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
      locale,
      at: new Date().toISOString(),
    }, t);
    const ok = await writeClipboard(text);
    setCopyFailed(!ok);
    setCopied(ok ? visible.length : null);
  }

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
        {writeClipboard ? (
          <button
            type="button"
            onClick={() => void copyVisible()}
            disabled={visible.length === 0}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold transition disabled:opacity-50 ${copied === null ? "border-zinc-200 text-zinc-400 dark:border-zinc-700" : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"}`}
          >
            {copied === null ? <Clipboard size={10} /> : <Check size={10} />}
            {copied === null ? t("copyActivityLog") : t("copyActivityLogCopied", String(copied))}
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
        <p role="alert" className="px-0.5 text-[10px] font-medium text-red-500">{t("clearActivityFailed")}</p>
      ) : null}
      {copyFailed ? (
        <p role="alert" className="px-0.5 text-[10px] font-medium text-red-500">{t("copyActivityLogFailed")}</p>
      ) : null}
      <div className="overflow-hidden rounded-xl border border-zinc-200/70 bg-white/70 dark:border-zinc-800 dark:bg-zinc-900/50">
        {visible.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-[11px] text-zinc-400">{t(showDiagnostics ? "noDiagnostics" : "noActivity")}</p>
        ) : (
          <ul className="space-y-1 p-1">
            {visible.map((event) => (
              showDiagnostics
                ? <CompactActivityRow key={event.id} event={event} />
                : <ActivityTimelineCard key={event.id} event={event} />
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

function CompactActivityRow({ event }: { event: ActivityHistoryRecord }): React.ReactElement {
  const t = useT();

  return (
    <li className="flex items-start gap-2 px-2.5 py-1.5 text-[11px] leading-snug">
      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: EVENT_LEVEL_COLOR[event.level] }} />
      <span className="shrink-0 font-mono text-[10px] text-zinc-400">{formatEventTime(event.at)}</span>
      <span className="min-w-0 break-words text-zinc-600 dark:text-zinc-300">{formatActivityEvent(event, t)}</span>
    </li>
  );
}

function ActivityTimelineCard({ event }: { event: ActivityHistoryRecord }): React.ReactElement {
  const t = useT();
  const runtime = React.useContext(PopupRuntimeContext);
  const card = buildActivityCard(event, t);
  if (!card) return <CompactActivityRow event={event} />;

  const campaignActionLabel = card.campaignName
    ? `${t("viewDropPage")}: ${card.campaignName}`
    : t("viewDropPage");

  return (
    <li
      data-activity-card={event.code}
      className="flex items-start gap-2 rounded-lg border-s-2 bg-zinc-50/70 px-2.5 py-2 text-[11px] leading-snug dark:bg-zinc-900/60"
      style={{ borderColor: EVENT_LEVEL_COLOR[event.level] }}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--accent-softer)] text-[var(--accent-text)]">
        {card.reward ? <ActivityRewardImage name={card.reward.name} imageUrl={card.reward.imageUrl} /> : <EventIcon icon={card.icon} aria-hidden="true" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <p className="min-w-0 break-words font-medium text-zinc-700 dark:text-zinc-200">{card.summary}</p>
          <time className="shrink-0 font-mono text-[10px] text-zinc-400">{formatEventTime(event.at)}</time>
        </div>
        {card.detail ? <p className="mt-0.5 break-words text-zinc-500 dark:text-zinc-400">{card.detail}</p> : null}
        {card.chips.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {card.chips.map((chip) => (
              <span key={chip} data-activity-chip={chip}>
                <Pill tone={activityCardPillTone(card.tone)}>{chip}</Pill>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {card.campaignUrl && runtime ? (
        <button
          type="button"
          aria-label={campaignActionLabel}
          title={campaignActionLabel}
          onClick={(clickEvent) => {
            clickEvent.stopPropagation();
            openHttpsLink(card.campaignUrl!, runtime.adapter.openLink);
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 outline-none transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent-text)] focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:text-zinc-500"
        >
          <ExternalLink size={13} aria-hidden="true" />
        </button>
      ) : null}
    </li>
  );
}

function ActivityRewardImage({ name, imageUrl }: { name: string; imageUrl?: string }): React.ReactElement {
  const source = imageUrl?.trim() || undefined;
  const initial = name.trim().charAt(0).toLocaleUpperCase() || "?";

  return (
    <ImageWithFallback
      src={source}
      alt={name}
      fit="contain"
      className="p-0.5"
      fallback={<span data-activity-reward-fallback role="img" aria-label={name} className="text-sm font-bold">{initial}</span>}
    />
  );
}

function EventIcon({ icon, ...props }: { icon: ActivityCardIcon } & React.ComponentProps<LucideIcon>): React.ReactElement {
  const icons = {
    gift: Gift,
    play: Play,
    pause: Pause,
    trophy: Trophy,
    triangle: AlertTriangle,
    "monitor-up": MonitorUp,
    "monitor-down": MonitorDown,
    shield: Shield,
    "octagon-alert": OctagonAlert,
    refresh: RefreshCw,
  } satisfies Record<ActivityCardIcon, LucideIcon>;
  const Icon = icons[icon];
  return <Icon size={17} {...props} />;
}

function activityCardPillTone(tone: ActivityCardTone): "muted" | "accent" | "live" | "warning" | "danger" {
  switch (tone) {
    case "success": return "live";
    case "accent": return "accent";
    case "danger": return "danger";
    case "warning": return "warning";
    case "muted": return "muted";
  }
}
