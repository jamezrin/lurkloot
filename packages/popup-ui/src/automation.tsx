import { Eye, Gift, Play, Radio } from "lucide-react";
import type { Platform } from "@lurkloot/shared/models";
import type { AutomationPresentation } from "./automationStatus";
import { usePopupRuntime, useT } from "./context";
import { formatViewers } from "./format";
import type { FarmingChannelView } from "./types";
import { Pill, cn } from "./primitives";
import { Tip } from "./tooltip";

// Both names in the status line open something — the channel its stream, the
// campaign its card — so both carry a standing underline rather than only
// revealing one on hover.
export const LINK_CLASS = "truncate font-semibold text-zinc-800 underline decoration-dotted decoration-current/30 underline-offset-2 outline-none hover:text-[var(--accent-text)] hover:decoration-current focus-visible:text-[var(--accent-text)] dark:text-zinc-100";

/** Colour of the status dot for a platform's current automation state. Shared by
 * the rail's platform switch and the status line so both read the same at a glance. */
export function statusColor(presentation: AutomationPresentation, operationalColor: string): string | undefined {
  if (presentation.operational) return operationalColor;
  if (presentation.state === "blocked") return "#ef4444";
  if (presentation.state === "needs_sign_in" || presentation.state === "unavailable") return "#f59e0b";
  return undefined;
}

/** What the automation is doing right now, on one line of popup chrome.
 *
 * The line height is fixed for every steady state (running/paused/checking/…) so
 * the five-second snapshot poll can never resize the header and shove the
 * campaign list under the pointer. Only the states carrying a call to action —
 * sign-in, blocked, unavailable, tab-closed — are allowed to grow, and there the
 * movement is the point. */
export function AutomationStatusLine({ platform, presentation, farmingTitle, farmingChannel, watchingIdleWatchlist = false, onFarmingTitleClick, onResume }: { platform: Platform; presentation: AutomationPresentation; farmingTitle?: string; farmingChannel?: FarmingChannelView; watchingIdleWatchlist?: boolean; onFarmingTitleClick?(): void; onResume?(): void }) {
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
          // Two groups, each labelled by a glyph so the numbers and names are not
          // bare: where it is watching (channel + eye/viewers) and what that earns
          // (gift/campaign). Both names are links, so both are underlined.
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <Radio size={11} className="shrink-0" style={{ color: "var(--accent-text)" }} />
            <span className="shrink-0">{t("watchingLabel")}</span>
            {/* The channel holds its width and the campaign absorbs the
                truncation: the campaign name is also spelled out in the list
                below, the channel is not written anywhere else. */}
            {farmingChannel.url ? (
              <Tip label={`${t("watchingLabel")} ${farmingChannel.name}`}>
                <a href={farmingChannel.url} target="_blank" rel="noreferrer" className={cn(LINK_CLASS, "max-w-[7.5rem] shrink-0")}>{farmingChannel.name}</a>
              </Tip>
            ) : (
              <span className="max-w-[7.5rem] shrink-0 truncate font-semibold text-zinc-800 dark:text-zinc-100">{farmingChannel.name}</span>
            )}
            {farmingChannel.viewers != null && (
              // The eye carries the meaning visually; role+label carries it to a
              // screen reader, which would otherwise hear a bare "18K".
              <Tip label={t("viewerCount", formatViewers(farmingChannel.viewers))}>
                <span className="shrink-0" role="img" aria-label={t("viewerCount", formatViewers(farmingChannel.viewers))}>
                  <Pill tone="muted"><Eye size={9} aria-hidden />{formatViewers(farmingChannel.viewers)}</Pill>
                </span>
              </Tip>
            )}
            {farmingTitle && (
              <span className="ml-auto flex min-w-0 items-center gap-1 pl-1">
                <Gift size={11} className="shrink-0" aria-hidden style={{ color: "var(--accent-text)" }} />
                {onFarmingTitleClick ? (
                  <Tip label={`${t("farmingLabel")} ${farmingTitle}`}>
                    <button type="button" onClick={onFarmingTitleClick} className={cn(LINK_CLASS, "min-w-0 text-left")}>{farmingTitle}</button>
                  </Tip>
                ) : (
                  <span className="min-w-0 truncate font-semibold text-zinc-800 dark:text-zinc-100">{farmingTitle}</span>
                )}
              </span>
            )}
            {watchingIdleWatchlist && (
              <span className="ml-auto flex min-w-0 items-center gap-1 pl-1 text-zinc-700 dark:text-zinc-200">
                <Play size={11} className="shrink-0" aria-hidden style={{ color: "var(--accent-text)" }} />
                <span className="truncate font-semibold">{t("idleWatchlistTab")}</span>
              </span>
            )}
          </span>
        ) : presentation.state === "running" ? (
          <Tip label={t("waitingEligibleStream")}>
            <span className="truncate">{t("waitingEligibleStream")}</span>
          </Tip>
        ) : presentation.manualWatchChannel ? (
          // "that tab" is not actionable with several streams open, so the pause
          // names the stream that caused it and links to it (#562). Its own
          // branch because detailKey renders with no arguments.
          <span className={cn("min-w-0", roomy ? "line-clamp-2 leading-snug" : "truncate")}>
            <span className="font-semibold text-zinc-600 dark:text-zinc-300">{t(presentation.badgeKey)}</span>
            <span className="text-zinc-300 dark:text-zinc-600"> · </span>
            {presentation.manualWatchChannel.url ? (
              <a
                href={presentation.manualWatchChannel.url}
                target="_blank"
                rel="noreferrer"
                data-manual-watch-channel
                className={cn(LINK_CLASS, "inline-block max-w-[7.5rem] align-bottom")}
              >
                {presentation.manualWatchChannel.name}
              </a>
            ) : (
              <span data-manual-watch-channel className="font-semibold text-zinc-800 dark:text-zinc-100">{presentation.manualWatchChannel.name}</span>
            )}
            <span> </span>
            {t("manualWatchPauseDetailNamedSuffix")}
          </span>
        ) : (
          <Tip label={detail ? `${t(presentation.badgeKey)} · ${detail}` : t(presentation.badgeKey)}>
            <span className={cn("min-w-0", roomy ? "line-clamp-2 leading-snug" : "truncate")}>
              <span className="font-semibold text-zinc-600 dark:text-zinc-300">{t(presentation.badgeKey)}</span>
              {detail ? (
                <>
                  <span className="text-zinc-300 dark:text-zinc-600"> · </span>
                  {detail}
                </>
              ) : null}
            </span>
          </Tip>
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
