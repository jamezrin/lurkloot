import React, { useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { CriticalFailureReason } from "@lurkloot/shared/criticalHealth";
import type { Platform } from "@lurkloot/shared/models";
import { GITHUB_NEW_ISSUE_URL_BASE } from "./constants";
import { openHttpsLink } from "./links";
import { useT } from "./context";

export interface CriticalFailurePanelProps {
  platform: Platform;
  reason: CriticalFailureReason;
  buildReport(): string;
  onDismiss(): void;
  openLink(url: string): void;
  writeClipboard(text: string): Promise<boolean>;
}

// The report itself goes on the clipboard rather than into the URL: issue bodies
// large enough to matter would be truncated by URL length limits, and the users
// with the most to report are exactly the ones who would lose it.
function issueUrl(platform: Platform, reason: CriticalFailureReason): string {
  const title = `Critical failure: ${reason} on ${platform}`;
  const body = "<!-- Paste the copied report below. -->\n\n";
  return `${GITHUB_NEW_ISSUE_URL_BASE}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

export function CriticalFailurePanel({
  platform,
  reason,
  buildReport,
  onDismiss,
  openLink,
  writeClipboard,
}: CriticalFailurePanelProps): React.ReactElement {
  const t = useT();
  const [fallbackReport, setFallbackReport] = useState<string | null>(null);

  async function copyAndReport(): Promise<void> {
    const report = buildReport();
    // The clipboard write happens inside the click gesture, and the issue only
    // opens once it succeeds. Sending someone to a blank issue form with an empty
    // clipboard is worse than showing them the text to copy by hand.
    // A denied or unavailable clipboard can reject rather than resolve false, and
    // an unhandled rejection here would leave the user with neither the issue form
    // nor the manual-copy textarea — so treat any failure the same way.
    const copied = await writeClipboard(report).catch(() => false);
    if (copied) {
      setFallbackReport(null);
      openHttpsLink(issueUrl(platform, reason), openLink);
      return;
    }
    setFallbackReport(report);
  }

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/40">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-red-600 dark:text-red-400">
          <AlertTriangle size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-tight text-red-900 dark:text-red-200">
            {t("criticalFailureTitle")}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-red-800 dark:text-red-300">
            {t(reason === "page_context_churn" ? "criticalFailureBodyTabChurn" : "criticalFailureBodyNoProgress")}
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void copyAndReport()}
          className="inline-flex items-center rounded-lg bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-red-400"
        >
          {t("criticalFailureCopyAndReport")}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex items-center rounded-lg border border-red-300 px-2.5 py-1 text-[11px] font-semibold text-red-800 outline-none transition-colors hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-400 dark:border-red-800 dark:text-red-200 dark:hover:bg-red-900/40"
        >
          {t("criticalFailureDismiss")}
        </button>
      </div>
      {fallbackReport === null ? null : (
        <div className="mt-2.5">
          <p className="text-[11px] leading-snug text-red-800 dark:text-red-300">
            {t("criticalFailureClipboardFallback")}
          </p>
          <textarea
            readOnly
            value={fallbackReport}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-1 h-28 w-full rounded-lg border border-red-200 bg-white p-2 font-mono text-[10px] text-zinc-700 dark:border-red-900 dark:bg-zinc-900 dark:text-zinc-200"
          />
        </div>
      )}
    </div>
  );
}
