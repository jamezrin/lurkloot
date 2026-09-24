import React, { useState } from "react";
import { AnimatePresence } from "motion/react";
import { AlertTriangle, Check, Gift, Package, Puzzle, Sparkles, type LucideIcon } from "lucide-react";
import { Pill, ProgressBar, SectionHeader, Toggle, cn } from "./primitives";
import type { ExtensionSettings, TwitchExtensionProviderId, TwitchExtensionSummary } from "@lurkloot/shared/models";
import type { PopupAdapter } from "./types";
import { useT } from "./context";
import { WatchSourcePlace } from "./watchSourcePriority";
import { SettingRow, SettingsSection } from "./settingsControls";

type PillTone = React.ComponentProps<typeof Pill>["tone"];

const PROVIDERS = [
  { id: "nopixel", name: "NoPixelV", icon: Gift, hint: "extensionNoPixelHint", optionTitle: "extensionAutoOpenPacksTitle", optionHint: "extensionAutoOpenPacksHint" },
  { id: "fortnite", name: "Fortnite", icon: Sparkles, hint: "extensionFortniteHint", optionTitle: "extensionTakeoversTitle", optionHint: "extensionTakeoversHint" },
] as const satisfies readonly { id: TwitchExtensionProviderId; name: string; icon: LucideIcon; hint: string; optionTitle: string; optionHint: string }[];

export async function changeTwitchExtensionEnabled(adapter: PopupAdapter, provider: TwitchExtensionProviderId, enabled: boolean): Promise<boolean> {
  // Invoke the browser prompt before any await so the host preserves the click
  // gesture. Background independently verifies the grant before persisting.
  if (enabled && !await adapter.requestTwitchExtensionPermission?.(provider)) return false;
  const result = await adapter.send<{ enabled: boolean }>({ type: "setTwitchExtensionEnabled", provider, enabled });
  return result.enabled === true;
}

function statusKey(provider: TwitchExtensionProviderId, summary: TwitchExtensionSummary | undefined): string {
  if (!summary) return "extensionIdle";
  switch (summary.reasonCode) {
    case "identity-required": return "extensionIdentityRequired";
    case "permission-required": return "extensionPermissionRequired";
    case "auth-required": return "extensionAuthRequired";
    case "channel-required": case "channel-ineligible": case "channel-not-connected": return "extensionChannelRequired";
    // NoPixelV completion covers daily watchtime only; packs and giveaways
    // are reported separately, so "Rewards earned" would overstate it.
    case "rewards-complete": return provider === "nopixel" ? "extensionWatchtimeComplete" : "extensionComplete";
    case "watchtime": case "collecting": case "giveaway": return "extensionFarming";
    case "phase-closed": return "extensionPhaseClosed";
    case "connecting": return "extensionConnecting";
    default: return summary.status === "error" ? "extensionUnavailable" : "extensionIdle";
  }
}

function statusTone(summary: TwitchExtensionSummary | undefined): PillTone {
  switch (summary?.reasonCode) {
    // Every enabled provider is probed on the watched channel, so "not on this
    // channel" is the normal state while a drop or another provider holds it.
    case "channel-required": case "channel-ineligible": case "channel-not-connected": case "phase-closed": return "muted";
  }
  switch (summary?.status) {
    case "complete": return "live";
    case "farming": return "accent";
    case "error": case "unavailable": return "warning";
    default: return "muted";
  }
}

interface Badge { key: string; icon: LucideIcon; tone: PillTone; label: string; count?: number }

// Secondary states render as icon-only badges; the label is the tooltip and
// accessible name so the row stays one line tall.
function StatusBadge({ badge }: { badge: Badge }) {
  const Icon = badge.icon;
  return (
    <span role="img" aria-label={badge.label} title={badge.label} className="inline-flex">
      <Pill tone={badge.tone}><Icon size={9} />{badge.count !== undefined ? <span className="tabular-nums">{badge.count}</span> : null}</Pill>
    </span>
  );
}

function providerDetails(provider: TwitchExtensionProviderId, summary: TwitchExtensionSummary | undefined, t: ReturnType<typeof useT>): { progress?: { label: string; percent: number; earned: number; required: number }; badges: Badge[] } {
  const badges: Badge[] = [];
  if (!summary) return { badges };
  let progress: { label: string; percent: number; earned: number; required: number } | undefined;
  const percentOf = (earned: number, required: number) => required > 0 ? Math.min(100, (earned / required) * 100) : 0;
  if (provider === "nopixel") {
    const daily = summary.progress.find((item) => item.key === "daily-pack");
    if (daily) progress = { label: t("extensionDailyPackProgress", [String(daily.earned), String(daily.required)]), percent: percentOf(daily.earned, daily.required), earned: daily.earned, required: daily.required };
    const giveaway = summary.pending.find((item) => item.key === "giveaway");
    if (giveaway?.state === "done") badges.push({ key: "giveaway", icon: Check, tone: "live", label: t("extensionGiveawayEntered") });
    if (giveaway?.state === "open") badges.push({ key: "giveaway", icon: Gift, tone: "accent", label: t("extensionGiveawayOpen") });
    if (giveaway?.state === "blocked") badges.push({ key: "giveaway", icon: AlertTriangle, tone: "warning", label: t("extensionGiveawayUnavailable") });
    const unopened = summary.progress.find((item) => item.key === "rewards");
    if (unopened) badges.push({ key: "packs", icon: Package, tone: "muted", label: t("extensionUnopenedPacks", String(unopened.required)), count: unopened.required });
    if (summary.pending.some((item) => item.key === "completion" && item.state === "blocked")) badges.push({ key: "pack-check", icon: AlertTriangle, tone: "warning", label: t("extensionPackCheckUnavailable") });
  } else {
    const captures = summary.progress.find((item) => item.key === "phase-captures") ?? summary.progress[0];
    if (captures) progress = { label: t(captures.key === "rewards" ? "extensionRewardProgress" : "extensionCaptureProgress", [String(captures.earned), String(captures.required)]), percent: percentOf(captures.earned, captures.required), earned: captures.earned, required: captures.required };
    if (summary.pending.some((item) => item.key === "takeover" && item.state === "done")) badges.push({ key: "takeover", icon: Sparkles, tone: "accent", label: t("extensionTakeoverActive") });
  }
  return { progress, badges };
}

// One line per provider, never expandable: everything a provider can report
// fits in the row, so there is no hidden body to disclose. The provider that
// holds the Twitch session is emphasized; the rest are visibly just waiting.
function ProviderCard({ provider, summary, active, onSetup }: {
  provider: typeof PROVIDERS[number];
  summary?: TwitchExtensionSummary;
  active: boolean;
  onSetup?(): void;
}) {
  const t = useT();
  const Icon = provider.icon;
  const { progress, badges } = providerDetails(provider.id, summary, t);
  const waiting = !active && (!summary || statusTone(summary) === "muted" && summary.status !== "complete");
  const status = t(waiting && !progress ? "extensionIdle" : statusKey(provider.id, summary));
  return (
    <article
      aria-label={provider.name}
      aria-current={active ? "true" : undefined}
      className={cn(
        "relative flex h-8 items-center gap-2 overflow-hidden rounded-xl border bg-white px-2.5 dark:bg-zinc-900",
        active ? "border-[var(--accent-ring)] shadow-sm" : "border-zinc-200 dark:border-zinc-800",
      )}
      style={active ? { boxShadow: "0 8px 22px -16px var(--accent-glow)" } : undefined}
    >
      <Icon size={13} className={cn("shrink-0", waiting && "opacity-60")} style={{ color: "var(--accent-text)" }} />
      <span className={cn("shrink-0 text-[12px] font-semibold", waiting ? "text-zinc-500 dark:text-zinc-400" : "text-zinc-900 dark:text-zinc-50")}>{provider.name}</span>
      {active ? <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ backgroundColor: "var(--accent)" }} /> : null}
      {/* The full sentence ("Daily pack: 45/60 minutes") truncates beside the
          status pill at popup width, so the row shows the count and keeps the
          sentence as the tooltip and the <progress> accessible name. */}
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium tabular text-zinc-500 dark:text-zinc-400" title={progress?.label}>
        {progress ? `${progress.earned}/${progress.required}` : null}
      </span>
      {badges.map((badge) => <StatusBadge key={badge.key} badge={badge} />)}
      {summary?.reasonCode === "identity-required" && onSetup ? (
        <button
          type="button"
          onClick={onSetup}
          title={t("extensionAccountSetup")}
          className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
        >
          <Pill tone="warning">{status}</Pill>
        </button>
      ) : (
        <span className="shrink-0"><Pill tone={waiting ? "muted" : statusTone(summary)}>{status}</Pill></span>
      )}
      {progress ? (
        <>
          <progress className="sr-only" aria-label={progress.label} value={progress.earned} max={Math.max(progress.required, progress.earned, 1)} />
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0">
            <ProgressBar value={progress.percent} size="edge" glow={active} />
          </div>
        </>
      ) : null}
    </article>
  );
}

export function TwitchExtensionDrops({ settings, summaries, activeProvider, onSetup }: {
  settings: ExtensionSettings;
  summaries?: Partial<Record<TwitchExtensionProviderId, TwitchExtensionSummary>>;
  // The provider the scheduler selected for the Twitch session, if any.
  activeProvider?: string;
  onSetup?(): void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const enabled = PROVIDERS.filter((provider) => settings.twitchExtensions[provider.id].enabled);
  if (enabled.length === 0) return null;
  const completed = enabled.filter((provider) => summaries?.[provider.id]?.status === "complete").length;
  return (
    <section aria-label={t("extensionDropsTitle")} className="space-y-1.5">
      <SectionHeader
        label={t("extensionDropsTitle")}
        count={`${completed}/${enabled.length}`}
        icon={Puzzle}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
      <AnimatePresence initial={false}>
        {expanded ? (
          <div className="lurk-reveal">
            <div className="space-y-1.5">
              {enabled.map((provider) => (
                <ProviderCard key={provider.id} provider={provider} summary={summaries?.[provider.id]} active={activeProvider === provider.id} onSetup={onSetup} />
              ))}
            </div>
          </div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

export const TWITCH_EXTENSION_PROVIDERS = PROVIDERS;

/** One provider, in a destination of its own.
 *
 * The grouped list could only afford a name, a count and a couple of badges per
 * provider; here everything the summary carries is visible at once — status,
 * progress, every badge, the provider's own option, and the way to turn it off. */
export function TwitchExtensionView({ providerId, settings, summary, active, pending, onEnabledChange, onOptionChange, onSetup, onChangeOrder }: {
  providerId: TwitchExtensionProviderId;
  settings: ExtensionSettings;
  summary?: TwitchExtensionSummary;
  active: boolean;
  pending: boolean;
  onEnabledChange(enabled: boolean): void | Promise<void>;
  onOptionChange(enabled: boolean): void | Promise<void>;
  onSetup?(): void;
  onChangeOrder?(): void;
}) {
  const t = useT();
  const provider = PROVIDERS.find((entry) => entry.id === providerId)!;
  const Icon = provider.icon;
  const enabled = settings.twitchExtensions[providerId].enabled;
  const option = providerId === "nopixel"
    ? settings.twitchExtensions.nopixel.autoOpenPacks
    : settings.twitchExtensions.fortnite.allowTakeovers;
  const { progress, badges } = providerDetails(providerId, summary, t);

  return (
    <section aria-label={provider.name} className="space-y-2">
      <div className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", enabled ? "bg-[var(--accent-soft)] text-[var(--accent-text)]" : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500")}>
          <Icon size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">
            {provider.name}
            {active ? <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ backgroundColor: "var(--accent)" }} /> : null}
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t(provider.hint)}</div>
        </div>
        <Toggle checked={enabled} disabled={pending} onChange={onEnabledChange} label={provider.name} />
      </div>

      {enabled ? (
        <>
          <div className="space-y-2 rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-100">
                {t(statusKey(providerId, summary))}
              </span>
              {progress ? (
                <span className="font-mono text-[11px] tabular text-zinc-500 dark:text-zinc-400">{progress.earned}/{progress.required}</span>
              ) : null}
            </div>
            {progress ? (
              <>
                <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className="h-full rounded-full" style={{ width: `${progress.percent}%`, backgroundColor: "var(--accent)" }} />
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{progress.label}</p>
              </>
            ) : (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t("extensionIdle")}</p>
            )}
            {badges.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {badges.map((badge) => <StatusBadge key={badge.key} badge={badge} />)}
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-zinc-800 dark:text-zinc-100">{t(provider.optionTitle)}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t(provider.optionHint)}</div>
            </div>
            <Toggle checked={option} disabled={pending} onChange={onOptionChange} label={t(provider.optionTitle)} />
          </div>
        </>
      ) : (
        <p className="rounded-2xl border border-dashed border-zinc-200 p-3 text-[11px] leading-snug text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          {t("extensionSettingsHint")}
        </p>
      )}

      {onChangeOrder ? (
        <WatchSourcePlace source={providerId} order={settings.platform.twitch.watchSourcePriority} onChangeOrder={onChangeOrder} />
      ) : null}

      {onSetup ? (
        <button type="button" onClick={onSetup} className="text-[11px] font-semibold text-[var(--accent-text)] hover:underline">
          {t("extensionAccountSetup")}
        </button>
      ) : null}
    </section>
  );
}

export function twitchExtensionSearchText(t: (key: string) => string): string {
  return [
    t("extensionSettingsTitle"),
    t("extensionSettingsHint"),
    ...PROVIDERS.flatMap((provider) => [provider.name, t(provider.hint), t(provider.optionTitle), t(provider.optionHint)]),
  ].join(" ").toLocaleLowerCase();
}

export function TwitchExtensionSettings({ settings, onChange, onTakeoversChange, onAutoOpenPacksChange, query = "" }: {
  settings: ExtensionSettings;
  query?: string;
  onChange(provider: TwitchExtensionProviderId, enabled: boolean): Promise<boolean>;
  onAutoOpenPacksChange(enabled: boolean): Promise<void>;
  onTakeoversChange(enabled: boolean): Promise<void>;
}) {
  const t = useT();
  const [pending, setPending] = useState<TwitchExtensionProviderId>();
  const [failure, setFailure] = useState<string>();

  async function run(provider: TwitchExtensionProviderId, operation: () => Promise<void>) {
    if (pending) return;
    setPending(provider);
    setFailure(undefined);
    try {
      await operation();
    } catch {
      setFailure("extensionUnavailable");
    } finally {
      setPending(undefined);
    }
  }

  const changeEnabled = (provider: TwitchExtensionProviderId, enabled: boolean) => run(provider, async () => {
    const result = await onChange(provider, enabled);
    if (enabled && !result) setFailure("extensionPermissionRequired");
  });
  const optionState = {
    nopixel: { checked: settings.twitchExtensions.nopixel.autoOpenPacks, onChange: (value: boolean) => run("nopixel", () => onAutoOpenPacksChange(value)) },
    fortnite: { checked: settings.twitchExtensions.fortnite.allowTakeovers, onChange: (value: boolean) => run("fortnite", () => onTakeoversChange(value)) },
  };

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (...texts: string[]) => !normalizedQuery || texts.join(" ").toLocaleLowerCase().includes(normalizedQuery);
  const groupMatch = matches(t("extensionSettingsTitle"), t("extensionSettingsHint"));
  const visible = PROVIDERS.filter((provider) => groupMatch || matches(provider.name, t(provider.hint), t(provider.optionTitle), t(provider.optionHint)));

  return (
    <SettingsSection id="twitch.extensions" title={t("extensionSettingsTitle")} description={t("extensionSettingsHint")} forceExpanded={Boolean(normalizedQuery)}>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
        {visible.map((provider) => {
          const Icon = provider.icon;
          const enabled = settings.twitchExtensions[provider.id].enabled;
          // The provider-specific option only means something once the provider
          // runs, so it stays out of the way until then — unless search hit it.
          const showOption = enabled || Boolean(normalizedQuery) && matches(t(provider.optionTitle), t(provider.optionHint));
          return (
            <div key={provider.id} className="py-2.5">
              <div className="flex items-center gap-3">
                <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", enabled ? "bg-[var(--accent-soft)] text-[var(--accent-text)]" : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500")}>
                  <Icon size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{provider.name}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t(provider.hint)}</div>
                </div>
                <Toggle label={provider.name} checked={enabled} disabled={pending !== undefined} onChange={(value) => changeEnabled(provider.id, value)} />
              </div>
              {showOption ? (
                <div className="ml-3.5 mt-2 border-l-2 border-zinc-100 pl-[1.625rem] dark:border-zinc-800">
                  <SettingRow
                    title={t(provider.optionTitle)}
                    description={t(provider.optionHint)}
                    checked={optionState[provider.id].checked}
                    disabled={pending !== undefined || !enabled}
                    onChange={optionState[provider.id].onChange}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {failure ? <p role="status" className="text-[11px] text-amber-700 dark:text-amber-400">{t(failure)}</p> : null}
    </SettingsSection>
  );
}
