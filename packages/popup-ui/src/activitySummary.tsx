import type React from "react";
import { History } from "lucide-react";
import type { Platform, WatchSession } from "@lurkloot/shared/models";
import { statusColor } from "./automation";
import type { AutomationPresentation } from "./automationStatus";
import { PLATFORMS } from "./constants";
import { useT } from "./context";
import { formatRelative } from "./format";

/** The Activity view for a host that keeps no activity history (the CLI,
 * which writes its events to its log). It says so instead of showing an empty
 * log, which would read as "nothing happened", and lists what the snapshot
 * itself carries: the last check and what each platform is doing. */
export function ActivityHostSummary({
  lastTickAt,
  presentation,
  sessions,
}: {
  lastTickAt?: string;
  presentation: Record<Platform, AutomationPresentation>;
  sessions: Record<Platform, WatchSession>;
}): React.ReactElement {
  const t = useT();
  const lastCheck = lastTickAt ? formatRelative(lastTickAt, t) : "";
  return (
    <section data-activity-summary className="space-y-2">
      <div className="flex gap-3 rounded-2xl border border-[var(--surface-edge)] bg-[var(--surface)] p-3.5">
        <History size={16} className="mt-0.5 shrink-0 text-zinc-400" aria-hidden />
        <div className="min-w-0 space-y-1">
          <h2 className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">
            {t("activityNoHistoryTitle")}
          </h2>
          <p className="text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {t("activityNoHistoryBody")}
          </p>
        </div>
      </div>
      <dl className="divide-y divide-[var(--surface-edge)] rounded-2xl border border-[var(--surface-edge)] bg-[var(--surface)] text-[12px]">
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          <dt className="text-zinc-500 dark:text-zinc-400">{t("activityLastCheck")}</dt>
          <dd
            data-activity-last-check
            className="ms-auto font-mono text-zinc-800 dark:text-zinc-100"
          >
            {lastCheck || t("activityNoCheckYet")}
          </dd>
        </div>
        {(Object.keys(PLATFORMS) as Platform[]).map((platform) => {
          const status = presentation[platform];
          const channel = sessions[platform]?.channel;
          const detail = status.detailKey ? t(status.detailKey) : undefined;
          return (
            <div
              key={platform}
              data-activity-platform={platform}
              className="flex items-start gap-3 px-3.5 py-2.5"
            >
              <dt className="flex shrink-0 items-center gap-1.5 font-semibold text-zinc-800 dark:text-zinc-100">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: statusColor(status, "var(--accent)") ?? "#a1a1aa" }}
                />
                {PLATFORMS[platform].label}
              </dt>
              <dd className="ms-auto min-w-0 text-end text-zinc-500 dark:text-zinc-400">
                <span className="font-semibold text-zinc-700 dark:text-zinc-200">
                  {t(status.badgeKey)}
                </span>
                {status.state === "running" && channel ? (
                  <>
                    {" "}
                    · {t("watchingLabel")} {channel.displayName ?? channel.username}
                  </>
                ) : detail ? (
                  <> · {detail}</>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
