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
export function TwitchExtensionStatus({ summaries, onSetup }: { onSetup?(): void; summaries?: Partial<Record<TwitchExtensionProviderId, TwitchExtensionSummary>> }) {
  const t = useT();
  if (!summaries || !providers.some(provider => summaries[provider.id])) return null;
  return <div className="space-y-1 px-3 pb-2" aria-live="polite">
    {providers.map(provider => {
      const summary = summaries[provider.id];
      if (!summary) return null;
      return <div key={provider.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className="font-medium text-zinc-700 dark:text-zinc-200">{provider.name}</span>
        <span>{t(reasonKey(summary))}</span>
        {summary.channel ? <span>{summary.channel.username}</span> : null}
        {summary.reasonCode === "identity-required" && onSetup ? <button type="button" onClick={onSetup} className="underline underline-offset-2">{t("extensionAccountSetup")}</button> : null}
        {summary.progress.map(progress => <span key={progress.key}>{t(progress.key === "daily-pack" ? "extensionDailyPackProgress" : "extensionCaptureProgress", [String(progress.earned), String(progress.required)])}</span>)}
      </div>;
    })}
  </div>;
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
