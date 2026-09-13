import React, { useState } from "react";
import type { ExtensionSettings, TwitchExtensionProviderId, TwitchExtensionSummary } from "@lurkloot/shared/models";
import type { PopupAdapter } from "./types";
import { useT } from "./context";
import { SettingRow, SettingsSection } from "./settingsControls";
const providers = [{ id: "nopixel", name: "NoPixelV", hint: "extensionNoPixelHint" }, { id: "fortnite", name: "Fortnite", hint: "extensionFortniteHint" }] as const;
export async function changeTwitchExtensionEnabled(adapter: PopupAdapter, provider: TwitchExtensionProviderId, enabled: boolean): Promise<boolean> {
  // Invoke the browser prompt before any await so the host preserves the click
  // gesture. Background independently verifies the grant before persisting.
  if (enabled && !await adapter.requestTwitchExtensionPermission?.(provider)) return false;
  const result = await adapter.send<{ enabled: boolean }>({ type: "setTwitchExtensionEnabled", provider, enabled });
  return result.enabled === true;
}
function reasonKey(summary: TwitchExtensionSummary): string {
  switch (summary.reasonCode) {
    case "identity-required": return "extensionIdentityRequired";
    case "permission-required": return "extensionPermissionRequired";
    case "auth-required": return "extensionAuthRequired";
    case "channel-required": case "channel-ineligible": case "channel-not-connected": return "extensionChannelRequired";
    case "rewards-complete": return "extensionComplete";
    case "watchtime": case "collecting": case "giveaway": return "extensionFarming";
    case "phase-closed": return "extensionPhaseClosed";
    case "connecting": return "extensionConnecting";
    default: return summary.status === "error" ? "extensionUnavailable" : "extensionIdle";
  }
}
function ProviderSection({ name, summary, children, onSetup }: { name: string; summary?: TwitchExtensionSummary; children: React.ReactNode; onSetup?(): void }) {
  const t = useT();
  const complete = summary?.status === "complete";
  const blocked = summary?.status === "error" || summary?.status === "unavailable";
  return <section aria-label={name} className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700/60 dark:bg-zinc-800/60">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">{name}</h2>
      <span className={`text-[11px] ${complete ? "text-emerald-700 dark:text-emerald-400" : blocked ? "text-amber-700 dark:text-amber-400" : "text-zinc-500 dark:text-zinc-400"}`}>{t(summary ? reasonKey(summary) : "extensionIdle")}</span>
    </div>
    {children}
    {summary?.reasonCode === "identity-required" && onSetup ? <button type="button" onClick={onSetup} className="mt-2 text-[11px] font-medium text-purple-600 underline underline-offset-2 dark:text-purple-400">{t("extensionAccountSetup")}</button> : null}
  </section>;
}
function RewardProgress({ label, earned, required, complete }: { label: string; earned: number; required: number; complete: boolean }) {
  const fraction = required > 0 ? Math.min(1, earned / required) : complete ? 1 : 0;
  return <div className="mt-2.5">
    <div className="mb-1.5 text-[11px] tabular-nums text-zinc-600 dark:text-zinc-300">{label}</div>
    <progress className="sr-only" aria-label={label} value={earned} max={Math.max(required, earned, 1)} />
    <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
      <div className={`h-full rounded-full ${complete ? "bg-emerald-500" : "bg-purple-500"}`} style={{ width: `${fraction * 100}%` }} />
    </div>
  </div>;
}
function NoPixelDropSection({ summary, onSetup }: { summary?: TwitchExtensionSummary; onSetup?(): void }) {
  const t = useT();
  const daily = summary?.progress.find(progress => progress.key === "daily-pack");
  return <ProviderSection name="NoPixelV" summary={summary} onSetup={onSetup}>
    {daily ? <RewardProgress label={t("extensionDailyPackProgress", [String(daily.earned), String(daily.required)])} earned={daily.earned} required={daily.required} complete={summary?.status === "complete"} /> : null}
    {summary?.pending.filter(action => action.key === "giveaway").map(action => <p key={action.key} className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">{t(action.state === "blocked" ? "extensionGiveawayUnavailable" : action.state === "done" ? "extensionGiveawayEntered" : "extensionGiveawayOpen")}</p>)}
  </ProviderSection>;
}
function FortniteDropSection({ summary, onSetup }: { summary?: TwitchExtensionSummary; onSetup?(): void }) {
  const t = useT();
  return <ProviderSection name="Fortnite" summary={summary} onSetup={onSetup}>
    {summary?.progress.map(progress => <RewardProgress key={progress.key} label={t(progress.key === "rewards" ? "extensionRewardProgress" : "extensionCaptureProgress", [String(progress.earned), String(progress.required)])} earned={progress.earned} required={progress.required} complete={progress.earned >= progress.required} />)}
    {summary?.pending.some(action => action.key === "takeover" && action.state === "done") ? <p className="mt-2 text-[11px] text-purple-600 dark:text-purple-400">{t("extensionTakeoverActive")}</p> : null}
  </ProviderSection>;
}
export function TwitchExtensionDrops({ settings, summaries, onSetup }: { settings: ExtensionSettings; onSetup?(): void; summaries?: Partial<Record<TwitchExtensionProviderId, TwitchExtensionSummary>> }) {
  return <>
    {settings.twitchExtensions.nopixel.enabled ? <NoPixelDropSection summary={summaries?.nopixel} onSetup={onSetup} /> : null}
    {settings.twitchExtensions.fortnite.enabled ? <FortniteDropSection summary={summaries?.fortnite} onSetup={onSetup} /> : null}
  </>;
}
export function TwitchExtensionSettings({ settings, onChange, onTakeoversChange }: { onTakeoversChange(enabled: boolean): Promise<void>; settings: ExtensionSettings; onChange(provider: TwitchExtensionProviderId, enabled: boolean): Promise<boolean> }) {
  const t = useT();
  const [pending, setPending] = useState<TwitchExtensionProviderId>();
  const [failure, setFailure] = useState<string>();
  async function change(provider: TwitchExtensionProviderId, enabled: boolean) {
    if (pending) return;
    setPending(provider); setFailure(undefined);
    try { const result = await onChange(provider, enabled); if (enabled && !result) setFailure("extensionPermissionRequired"); }
    catch { setFailure("extensionUnavailable"); }
    finally { setPending(undefined); }
  }
  async function changeTakeovers(enabled: boolean) {
    if (pending) return;
    setPending("fortnite"); setFailure(undefined);
    try { await onTakeoversChange(enabled); }
    catch { setFailure("extensionUnavailable"); }
    finally { setPending(undefined); }
  }
  return <SettingsSection id="twitch.extensions" title={t("extensionSettingsTitle")}>
    <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("extensionSettingsHint")}</p>
    {providers.map(provider => <SettingRow key={provider.id} title={provider.name} description={t(provider.hint)} checked={settings.twitchExtensions[provider.id].enabled} disabled={pending !== undefined} onChange={enabled => change(provider.id, enabled)} />)}
    <SettingRow title={t("extensionTakeoversTitle")} description={t("extensionTakeoversHint")} checked={settings.twitchExtensions.fortnite.allowTakeovers} disabled={pending !== undefined || !settings.twitchExtensions.fortnite.enabled} onChange={changeTakeovers} />
    {failure ? <p role="status" className="text-[11px] text-amber-700 dark:text-amber-400">{t(failure)}</p> : null}
  </SettingsSection>;
}
