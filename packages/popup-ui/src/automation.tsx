import { motion } from "motion/react";
import { Play, Radio } from "lucide-react";
import type { Platform } from "@lurkloot/shared/models";
import type { AutomationPresentation } from "./automationStatus";
import { PLATFORMS } from "./constants";
import { usePopupRuntime, useT } from "./context";
import { formatViewers } from "./format";
import type { FarmingChannelView } from "./types";
import { Toggle, cn } from "./primitives";

/** Colour of the status dot for a platform's current automation state. Shared by
 * the platform tabs and the status line so both read the same at a glance. */
export function statusColor(presentation: AutomationPresentation, operationalColor: string): string | undefined {
  if (presentation.operational) return operationalColor;
  if (presentation.state === "blocked") return "#ef4444";
  if (presentation.state === "needs_sign_in" || presentation.state === "unavailable") return "#f59e0b";
  return undefined;
}

/** Platform picker and the automation switch on one row: the toggle sits next to
 * the tabs so it reads as belonging to the selected platform, which is what it
 * has always controlled. */
export function PlatformBar({ active, presentation, enabled, pending, onChange, onToggle }: { active: Platform; presentation: Record<Platform, AutomationPresentation>; enabled: boolean; pending: boolean; onChange(platform: Platform): void; onToggle(value: boolean): Promise<void> }) {
  const t = useT();
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-1 rounded-xl bg-zinc-100/80 p-1 dark:bg-zinc-800/60">
        {Object.entries(PLATFORMS).map(([id, platform]) => {
          const selected = active === id;
          const status = presentation[id as Platform];
          const indicatorColor = statusColor(status, platform.color);
          return (
            <button key={id} type="button" data-platform-status={id} data-state={status.state} onClick={() => onChange(id as Platform)} title={`${platform.label}: ${t(status.badgeKey)}`} className={cn("relative flex items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-semibold transition-colors outline-none", selected ? "text-zinc-900 dark:text-white" : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200")}>
              {selected && <motion.span layoutId="platform-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} className="absolute inset-0 rounded-lg bg-white shadow-sm dark:bg-zinc-700" />}
              <span className="relative z-10 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-black" style={{ backgroundColor: selected ? platform.color : "transparent", color: selected ? (id === "kick" ? "#07140a" : "#fff") : platform.color, boxShadow: selected ? `0 0 12px -2px ${platform.color}` : undefined }}>
                {platform.mark}
              </span>
              <span className="relative z-10 truncate">{platform.label}</span>
              <span className="relative z-10 flex shrink-0 items-center" aria-hidden>
                {indicatorColor ? <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: indicatorColor, boxShadow: `0 0 6px ${indicatorColor}` }} /> : <span className="h-1.5 w-1.5 rounded-full border border-zinc-400 dark:border-zinc-500" />}
              </span>
            </button>
          );
        })}
      </div>
      <Toggle checked={enabled} onChange={onToggle} label={t("automationTitle", PLATFORMS[active].label)} disabled={pending} />
    </div>
  );
}

/** What the automation is doing right now, on one line of popup chrome.
 *
 * The line height is fixed for every steady state (running/paused/checking/…) so
 * the five-second snapshot poll can never resize the header and shove the
 * campaign list under the pointer. Only the states carrying a call to action —
 * sign-in, blocked, unavailable, tab-closed — are allowed to grow, and there the
 * movement is the point. */
export function AutomationStatusLine({ platform, presentation, farmingTitle, farmingChannel, onFarmingTitleClick, onResume }: { platform: Platform; presentation: AutomationPresentation; farmingTitle?: string; farmingChannel?: FarmingChannelView; onFarmingTitleClick?(): void; onResume?(): void }) {
  const t = useT();
  const runtime = usePopupRuntime();
  const action = presentation.action;
  const dotColor = statusColor(presentation, "var(--accent)") ?? "#a1a1aa";
  // States that carry a call to action, or a diagnosis too long to read in one
  // truncated line, get a second line. Everything the five-second poll actually
  // flaps between stays on the fixed single line.
  const roomy = Boolean(action) || presentation.state === "blocked" || presentation.state === "unavailable";
  const detail = presentation.detailKey ? t(presentation.detailKey) : undefined;

  return (
    <div data-automation-state={presentation.state} className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
      <div className={cn("flex gap-1.5", roomy ? "items-start" : "h-5 items-center")}>
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", roomy && "mt-1.5")}
          style={{ backgroundColor: dotColor, boxShadow: presentation.operational ? `0 0 6px ${dotColor}` : undefined }}
        />
        {presentation.state === "running" && farmingChannel ? (
          <span className="flex min-w-0 items-center gap-1">
            <Radio size={11} className="shrink-0" style={{ color: "var(--accent-text)" }} />
            <span className="shrink-0">{t("watchingLabel")}</span>
            {farmingChannel.url ? (
              <a href={farmingChannel.url} target="_blank" rel="noreferrer" className="max-w-[9rem] truncate font-semibold text-zinc-800 outline-none hover:text-[var(--accent-text)] hover:underline focus-visible:text-[var(--accent-text)] dark:text-zinc-100">{farmingChannel.name}</a>
            ) : (
              <span className="max-w-[9rem] truncate font-semibold text-zinc-800 dark:text-zinc-100">{farmingChannel.name}</span>
            )}
            {farmingChannel.viewers != null && <span className="shrink-0 text-zinc-400 dark:text-zinc-500">· {formatViewers(farmingChannel.viewers)}</span>}
            {farmingTitle && (
              <>
                <span className="shrink-0 text-zinc-300 dark:text-zinc-600">·</span>
                {onFarmingTitleClick ? (
                  <button type="button" onClick={onFarmingTitleClick} title={farmingTitle} className="truncate font-semibold text-zinc-800 outline-none hover:text-[var(--accent-text)] hover:underline focus-visible:text-[var(--accent-text)] dark:text-zinc-100">{farmingTitle}</button>
                ) : (
                  <span className="truncate font-semibold text-zinc-800 dark:text-zinc-100">{farmingTitle}</span>
                )}
              </>
            )}
          </span>
        ) : presentation.state === "running" ? (
          <span className="truncate" title={presentation.statusMessage}>{presentation.statusMessage ?? t("waitingEligibleStream")}</span>
        ) : (
          <span
            className={cn("min-w-0", roomy ? "line-clamp-2 leading-snug" : "truncate")}
            title={detail ? `${t(presentation.badgeKey)} · ${detail}` : t(presentation.badgeKey)}
          >
            <span className="font-semibold text-zinc-600 dark:text-zinc-300">{t(presentation.badgeKey)}</span>
            {detail ? (
              <>
                <span className="text-zinc-300 dark:text-zinc-600"> · </span>
                {detail}
              </>
            ) : null}
          </span>
        )}
      </div>
      {action?.kind === "link" ? (
        <button type="button" data-auth-action={platform} onClick={() => runtime.adapter.openLink(action.url)} className="mt-1 w-fit rounded-md bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-text)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]">
          {t(action.labelKey)}
        </button>
      ) : null}
      {action?.kind === "resume" ? (
        <button type="button" data-resume-action={platform} onClick={() => onResume?.()} className="mt-1 flex w-fit items-center gap-1 rounded-md bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent-text)] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]">
          <Play size={10} strokeWidth={2.6} />
          {t(action.labelKey)}
        </button>
      ) : null}
    </div>
  );
}
