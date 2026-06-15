import { motion } from "framer-motion";
import { Power, Radio } from "lucide-react";
import type { Platform } from "@lurkloot/shared/models";
import { PLATFORMS } from "./constants";
import { useT } from "./context";
import { formatViewers } from "./format";
import type { FarmingChannelView } from "./types";
import { Pill, Toggle, cn } from "./primitives";

export function PlatformSwitcher({ active, automation, onChange }: { active: Platform; automation: Record<Platform, boolean>; onChange(platform: Platform): void }) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-zinc-100/80 p-1 dark:bg-zinc-800/60">
      {Object.entries(PLATFORMS).map(([id, platform]) => {
        const selected = active === id;
        const running = automation[id as Platform];
        return (
          <button key={id} type="button" onClick={() => onChange(id as Platform)} title={`${platform.label} automation ${running ? "running" : "paused"}`} className={cn("relative flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors outline-none", selected ? "text-zinc-900 dark:text-white" : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200")}>
            {selected && <motion.span layoutId="platform-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} className="absolute inset-0 rounded-lg bg-white shadow-sm dark:bg-zinc-700" />}
            <span className="relative z-10 flex h-4 w-4 items-center justify-center rounded text-[10px] font-black" style={{ backgroundColor: selected ? platform.color : "transparent", color: selected ? (id === "kick" ? "#07140a" : "#fff") : platform.color, boxShadow: selected ? `0 0 12px -2px ${platform.color}` : undefined }}>
              {platform.mark}
            </span>
            <span className="relative z-10">{platform.label}</span>
            <span className="relative z-10 ml-0.5 flex items-center" aria-hidden>
              {running ? <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: platform.color, boxShadow: `0 0 6px ${platform.color}` }} /> : <span className="h-1.5 w-1.5 rounded-full border border-zinc-400 dark:border-zinc-500" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function AutomationHero({ platformLabel, enabled, pending, onChange, farmingTitle, farmingChannel, onFarmingTitleClick, statusMessage }: { platformLabel: string; enabled: boolean; pending: boolean; onChange(value: boolean): Promise<void>; farmingTitle?: string; farmingChannel?: FarmingChannelView; onFarmingTitleClick?(): void; statusMessage?: string }) {
  const t = useT();
  const status = pending ? (enabled ? t("automationStarting") : t("automationStopping")) : enabled ? t("automationRunning") : t("pausedStatus");

  return (
    <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-white p-3.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900" style={{ boxShadow: enabled ? "0 1px 2px rgba(0,0,0,0.04), 0 0 0 1px var(--accent-ring)" : undefined }}>
      {enabled && <div aria-hidden className="pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full blur-2xl" style={{ backgroundColor: "var(--accent-glow)", opacity: 0.5 }} />}
      <div className="relative flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors" style={{ backgroundColor: enabled ? "var(--accent)" : "var(--accent-soft)", color: enabled ? "var(--accent-contrast)" : "var(--accent-text)" }}>
          <Power size={20} strokeWidth={2.4} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{t("automationTitle", platformLabel)}</span>
            <Pill tone={enabled ? "accent" : "muted"}>{status}</Pill>
          </div>
          <div className="mt-0.5 flex h-[34px] flex-col justify-center text-xs text-zinc-500 dark:text-zinc-400">
            {pending ? (
              <p className="line-clamp-2 leading-snug">{enabled ? t("startingAutomation") : t("pausingAutomation")}</p>
            ) : enabled ? (
              <>
                {farmingChannel ? (
                  <p className="flex items-center gap-1 truncate">
                    <Radio size={11} className="shrink-0" style={{ color: "var(--accent-text)" }} />
                    {t("watchingLabel")}
                    {farmingChannel.url ? (
                      <a href={farmingChannel.url} target="_blank" rel="noreferrer" className="truncate font-semibold text-zinc-800 outline-none hover:text-[var(--accent-text)] hover:underline focus-visible:text-[var(--accent-text)] dark:text-zinc-100">{farmingChannel.name}</a>
                    ) : (
                      <span className="truncate font-semibold text-zinc-800 dark:text-zinc-100">{farmingChannel.name}</span>
                    )}
                    {farmingChannel.viewers != null && <span className="shrink-0 text-zinc-400 dark:text-zinc-500">· {formatViewers(farmingChannel.viewers)}</span>}
                  </p>
                ) : (
                  <p className="line-clamp-2 leading-snug" title={statusMessage}>{statusMessage ?? t("waitingEligibleStream")}</p>
                )}
                {farmingTitle && (
                  <p className="flex items-center gap-1 truncate">
                    <span className="shrink-0">{t("farmingLabel")}</span>
                    {onFarmingTitleClick ? (
                      <button type="button" onClick={onFarmingTitleClick} className="truncate font-semibold text-zinc-800 outline-none hover:text-[var(--accent-text)] hover:underline focus-visible:text-[var(--accent-text)] dark:text-zinc-100">{farmingTitle}</button>
                    ) : (
                      <span className="truncate font-semibold text-zinc-800 dark:text-zinc-100">{farmingTitle}</span>
                    )}
                  </p>
                )}
              </>
            ) : (
              <p className="line-clamp-2 leading-snug">{t("watchingPausedHint")}</p>
            )}
          </div>
        </div>
        <Toggle checked={enabled} onChange={onChange} label={t("automationTitle", platformLabel)} disabled={pending} />
      </div>
    </div>
  );
}
