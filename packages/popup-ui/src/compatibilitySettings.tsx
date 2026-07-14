import React from "react";
import type { CompatibilitySettings as CompatibilitySelections } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { ChevronDown, RotateCcw, TriangleAlert } from "lucide-react";
import { useT } from "./context";
import { SelectSettingRow } from "./settingsControls";
import { cn } from "./primitives";
import type { CompatibilityLifecycle, PopupCompatibilityRegistry, PopupCompatibilityResolution } from "./types";

export const AUTOMATIC_COMPATIBILITY_PATCH: SettingsPatch = Object.freeze({
  compatibility: Object.freeze({
    twitch: Object.freeze({ profile: "auto", heartbeatTransport: "auto", inventoryQueryVersion: "auto" }),
    kick: Object.freeze({ profile: "auto", claimLinkHandling: "auto" }),
  }),
});

const LIFECYCLE_KEYS: Record<CompatibilityLifecycle, string> = {
  recommended: "compatibilityLifecycleRecommended",
  legacy: "compatibilityLifecycleLegacy",
  experimental: "compatibilityLifecycleExperimental",
};

function isOverridden(settings: CompatibilitySelections): boolean {
  return Object.values(settings.twitch).some((value) => value !== "auto")
    || Object.values(settings.kick).some((value) => value !== "auto");
}

function options(records: Readonly<Record<string, { id: string; title: string; hosts: readonly string[]; identities?: readonly string[] }>>, automatic: string, webIdentity = false) {
  return [
    { value: "auto", label: automatic },
    ...Object.values(records)
      .filter((item) => item.hosts.includes("extension") && (!webIdentity || item.identities?.includes("web")))
      .map((item) => ({ value: item.id, label: `${item.title} (${item.id})` })),
  ];
}

function LifecycleBadge({ lifecycle }: { lifecycle: CompatibilityLifecycle }) {
  const t = useT();
  return <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-semibold", lifecycle === "recommended" ? "bg-emerald-500/10 text-emerald-600" : lifecycle === "legacy" ? "bg-amber-500/10 text-amber-600" : "bg-violet-500/10 text-violet-600")}>{t(LIFECYCLE_KEYS[lifecycle])}</span>;
}

function EffectiveItem({ id, lifecycle }: { id: string; lifecycle: CompatibilityLifecycle }) {
  return <li className="flex items-center justify-between gap-2"><code className="truncate text-[10px] text-zinc-600 dark:text-zinc-300">{id}</code><LifecycleBadge lifecycle={lifecycle} /></li>;
}

export function CompatibilitySettings({ settings, registry, resolution, onChange, expertExpanded, onExpertExpandedChange }: {
  settings: CompatibilitySelections;
  registry: PopupCompatibilityRegistry;
  resolution: PopupCompatibilityResolution;
  onChange(patch: SettingsPatch): void | Promise<void>;
  expertExpanded: boolean;
  onExpertExpandedChange(value: boolean): void;
}) {
  const t = useT();
  const automatic = t("compatibilityAutomatic");
  const effective = resolution.compatibility;
  const overridden = isOverridden(settings);
  const lifecycle = (records: Readonly<Record<string, { lifecycle: CompatibilityLifecycle }>>, id: string) => records[id]?.lifecycle ?? "experimental";
  return <div className="border-t border-zinc-100 py-2.5 dark:border-zinc-800/70">
    <SelectSettingRow title={t("compatibilityTwitchProfileTitle")} description={t("compatibilityTwitchProfileDescription")} value={settings.twitch.profile} options={options(registry.twitch.profiles, automatic, true)} onChange={(profile) => onChange({ compatibility: { twitch: { profile } } })} />
    <SelectSettingRow title={t("compatibilityKickProfileTitle")} description={t("compatibilityKickProfileDescription")} value={settings.kick.profile} options={options(registry.kick.profiles, automatic)} onChange={(profile) => onChange({ compatibility: { kick: { profile } } })} />
    <div className="rounded-lg bg-zinc-50 p-2 dark:bg-zinc-900/60">
      <div className="mb-1.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">{t("compatibilityEffectiveTitle")}</div>
      <ul className="space-y-1">
        <EffectiveItem id={effective.twitch.profile} lifecycle={lifecycle(registry.twitch.profiles, effective.twitch.profile)} />
        <EffectiveItem id={effective.twitch.heartbeat} lifecycle={lifecycle(registry.twitch.heartbeat, effective.twitch.heartbeat)} />
        <EffectiveItem id={effective.twitch.inventory} lifecycle={lifecycle(registry.twitch.inventory, effective.twitch.inventory)} />
        <EffectiveItem id={effective.kick.profile} lifecycle={lifecycle(registry.kick.profiles, effective.kick.profile)} />
        <EffectiveItem id={effective.kick.claim} lifecycle={lifecycle(registry.kick.claim, effective.kick.claim)} />
      </ul>
    </div>
    <button type="button" aria-expanded={expertExpanded} onClick={() => onExpertExpandedChange(!expertExpanded)} className="mt-2 flex w-full items-center justify-between rounded-lg px-1 py-1 text-[11px] font-semibold text-zinc-500">
      {t(expertExpanded ? "compatibilityExpertHide" : "compatibilityExpertShow")}<ChevronDown size={13} className={cn("transition-transform", expertExpanded && "rotate-180")} />
    </button>
    {expertExpanded ? <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
      <SelectSettingRow title={t("compatibilityTwitchHeartbeatTitle")} description={t("compatibilityTwitchHeartbeatDescription")} value={settings.twitch.heartbeatTransport} options={options(registry.twitch.heartbeat, automatic, true)} onChange={(heartbeatTransport) => onChange({ compatibility: { twitch: { heartbeatTransport } } })} />
      <SelectSettingRow title={t("compatibilityTwitchInventoryTitle")} description={t("compatibilityTwitchInventoryDescription")} value={settings.twitch.inventoryQueryVersion} options={options(registry.twitch.inventory, automatic, true)} onChange={(inventoryQueryVersion) => onChange({ compatibility: { twitch: { inventoryQueryVersion } } })} />
      <SelectSettingRow title={t("compatibilityKickClaimTitle")} description={t("compatibilityKickClaimDescription")} value={settings.kick.claimLinkHandling} options={options(registry.kick.claim, automatic)} onChange={(claimLinkHandling) => onChange({ compatibility: { kick: { claimLinkHandling } } })} />
      <div className="flex flex-wrap gap-1.5 py-2"><LifecycleBadge lifecycle="recommended" /><LifecycleBadge lifecycle="legacy" /><LifecycleBadge lifecycle="experimental" /></div>
    </div> : null}
    {overridden ? <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-500/10 p-2 text-[10px] text-amber-700 dark:text-amber-300"><TriangleAlert size={12} className="mt-0.5 shrink-0" /><span>{t("compatibilityOverrideWarning")}</span></div> : null}
    <button type="button" disabled={!overridden} onClick={() => void onChange(AUTOMATIC_COMPATIBILITY_PATCH)} className="mt-2 flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2 py-1 text-[11px] font-semibold text-zinc-500 disabled:opacity-40 dark:border-zinc-700"><RotateCcw size={12} />{t("compatibilityRestoreAutomatic")}</button>
  </div>;
}
