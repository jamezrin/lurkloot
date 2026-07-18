import React from "react";
import type { CompatibilitySettings as CompatibilitySelections } from "@lurkloot/shared/models";
import type { Platform } from "@lurkloot/shared/models";
import type { SettingsPatch } from "@lurkloot/shared/settings";
import { ChevronDown, RotateCcw, TriangleAlert } from "lucide-react";
import { PLATFORMS } from "./constants";
import { useT } from "./context";
import { SelectControl } from "./settingsControls";
import { cn } from "./primitives";
import type {
  CompatibilityLifecycle,
  CompatibilityOptionMetadata,
  PopupCompatibilityRegistry,
  PopupCompatibilityResolution,
  TFunction,
} from "./types";

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

const OPTION_TITLE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "twitch-2026-07": "compatibilityOptionTwitchProfile202607",
  "twitch-heartbeat-gql-v1": "compatibilityOptionTwitchHeartbeatGqlV1",
  "twitch-heartbeat-spade-v1": "compatibilityOptionTwitchHeartbeatSpadeV1",
  "twitch-heartbeat-trowel-v1": "compatibilityOptionTwitchHeartbeatTrowelV1",
  "twitch-inventory-v1": "compatibilityOptionTwitchInventoryV1",
  "kick-2026-07": "compatibilityOptionKickProfile202607",
  "kick-claim-v1": "compatibilityOptionKickClaimV1",
  "kick-claim-v2": "compatibilityOptionKickClaimV2",
});

type OptionRecords = Readonly<Record<string, CompatibilityOptionMetadata>>;
// "auto" means the row follows whatever the profile (or the resolver) picked.
// Anything else is an explicit user override of that one component.
type Selection = string;

function optionTitle(translate: TFunction, id: string): string {
  const titleKey = OPTION_TITLE_KEYS[id];
  return titleKey ? translate(titleKey) : id;
}

function isOverridden(settings: CompatibilitySelections): boolean {
  return Object.values(settings.twitch).some((value) => value !== "auto")
    || Object.values(settings.kick).some((value) => value !== "auto");
}

// Lifecycle rides along in the option label: a native <option> cannot carry a
// badge, and the tradeoff between choices is exactly what you need at the
// moment you open the dropdown.
function options(records: OptionRecords, automatic: string, translate: TFunction, webIdentity = false) {
  return [
    { value: "auto", label: automatic },
    ...Object.values(records)
      .filter((item) => item.hosts.includes("extension") && (!webIdentity || item.identities?.includes("web")))
      .map((item) => ({
        value: item.id,
        label: `${optionTitle(translate, item.id)} · ${translate(LIFECYCLE_KEYS[item.lifecycle])}`,
      })),
  ];
}

function LifecycleBadge({ lifecycle }: { lifecycle: CompatibilityLifecycle }) {
  const t = useT();
  return <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold leading-none whitespace-nowrap", lifecycle === "recommended" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : lifecycle === "legacy" ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "bg-violet-500/10 text-violet-600 dark:text-violet-400")}>{t(LIFECYCLE_KEYS[lifecycle])}</span>;
}

function PlatformGroup({ platform, children }: { platform: Platform; children: React.ReactNode }) {
  const details = PLATFORMS[platform];
  return (
    <div className="mt-3 first:mt-2">
      <div className="mb-0.5 flex items-center gap-1.5">
        <span className="flex h-4 w-4 items-center justify-center rounded text-[10px] font-black" style={{ backgroundColor: details.color, color: platform === "kick" ? "#07140a" : "#fff" }}>{details.mark}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{details.label}</span>
        <span className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800/70" />
      </div>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">{children}</div>
    </div>
  );
}

// One resolved component. The control and the value it produced sit together, so
// "Automatic" always says what it actually resolved to.
function CompatibilityRow({ title, ariaLabel, description, selection, resolvedId, metadata, options: rowOptions, onChange, editable, component }: {
  title: string;
  ariaLabel: string;
  description: string;
  selection: Selection;
  resolvedId: string;
  metadata?: CompatibilityOptionMetadata;
  options: Array<{ value: string; label: string }>;
  onChange(value: string): void | Promise<void>;
  editable: boolean;
  // Components inherit from the profile when left automatic; a profile row has
  // nothing above it to inherit from.
  component: boolean;
}) {
  const t = useT();
  const automatic = selection === "auto";
  const lifecycle = metadata?.lifecycle ?? "experimental";
  const replacement = metadata?.replacement;
  return (
    <div className="py-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-zinc-800 dark:text-zinc-100">{title}</div>
          {editable ? <div className="mt-0.5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</div> : null}
        </div>
        {editable
          ? <SelectControl label={ariaLabel} value={selection} options={rowOptions} onChange={onChange} />
          : <span className="shrink-0 text-[10px] font-semibold text-zinc-400 dark:text-zinc-500">{t("compatibilityFromProfile")}</span>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200">{optionTitle(t, resolvedId)}</span>
        <LifecycleBadge lifecycle={lifecycle} />
        {automatic
          ? (component && editable ? <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{t("compatibilityFromProfile")}</span> : null)
          : <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">{t("compatibilityOverridden")}</span>}
        <code className="w-full truncate text-[10px] text-zinc-400 dark:text-zinc-500">{resolvedId}</code>
        {replacement ? <span className="w-full text-[10px] text-amber-600 dark:text-amber-400">{t("compatibilityReplacedBy", optionTitle(t, replacement))}</span> : null}
      </div>
    </div>
  );
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
  const metadata = (records: OptionRecords, id: string) => records[id];

  return <div className="border-t border-zinc-100 py-2.5 dark:border-zinc-800/70">
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{t("compatibilitySectionTitle")}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{t("compatibilitySectionDescription")}</div>
      </div>
      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap", overridden ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400")}>{overridden ? t("compatibilityOverridden") : automatic}</span>
    </div>

    <PlatformGroup platform="twitch">
      <CompatibilityRow
        title={t("compatibilityComponentProfile")}
        ariaLabel={t("compatibilityTwitchProfileTitle")}
        description={t("compatibilityTwitchProfileDescription")}
        selection={settings.twitch.profile}
        resolvedId={effective.twitch.profile}
        metadata={metadata(registry.twitch.profiles, effective.twitch.profile)}
        options={options(registry.twitch.profiles, automatic, t, true)}
        onChange={(profile) => onChange({ compatibility: { twitch: { profile } } })}
        editable
        component={false}
      />
      <CompatibilityRow
        title={t("compatibilityComponentHeartbeat")}
        ariaLabel={t("compatibilityTwitchHeartbeatTitle")}
        description={t("compatibilityTwitchHeartbeatDescription")}
        selection={settings.twitch.heartbeatTransport}
        resolvedId={effective.twitch.heartbeat}
        metadata={metadata(registry.twitch.heartbeat, effective.twitch.heartbeat)}
        options={options(registry.twitch.heartbeat, automatic, t, true)}
        onChange={(heartbeatTransport) => onChange({ compatibility: { twitch: { heartbeatTransport } } })}
        editable={expertExpanded}
        component
      />
      <CompatibilityRow
        title={t("compatibilityComponentInventory")}
        ariaLabel={t("compatibilityTwitchInventoryTitle")}
        description={t("compatibilityTwitchInventoryDescription")}
        selection={settings.twitch.inventoryQueryVersion}
        resolvedId={effective.twitch.inventory}
        metadata={metadata(registry.twitch.inventory, effective.twitch.inventory)}
        options={options(registry.twitch.inventory, automatic, t, true)}
        onChange={(inventoryQueryVersion) => onChange({ compatibility: { twitch: { inventoryQueryVersion } } })}
        editable={expertExpanded}
        component
      />
    </PlatformGroup>

    <PlatformGroup platform="kick">
      <CompatibilityRow
        title={t("compatibilityComponentProfile")}
        ariaLabel={t("compatibilityKickProfileTitle")}
        description={t("compatibilityKickProfileDescription")}
        selection={settings.kick.profile}
        resolvedId={effective.kick.profile}
        metadata={metadata(registry.kick.profiles, effective.kick.profile)}
        options={options(registry.kick.profiles, automatic, t)}
        onChange={(profile) => onChange({ compatibility: { kick: { profile } } })}
        editable
        component={false}
      />
      <CompatibilityRow
        title={t("compatibilityComponentClaim")}
        ariaLabel={t("compatibilityKickClaimTitle")}
        description={t("compatibilityKickClaimDescription")}
        selection={settings.kick.claimLinkHandling}
        resolvedId={effective.kick.claim}
        metadata={metadata(registry.kick.claim, effective.kick.claim)}
        options={options(registry.kick.claim, automatic, t)}
        onChange={(claimLinkHandling) => onChange({ compatibility: { kick: { claimLinkHandling } } })}
        editable={expertExpanded}
        component
      />
    </PlatformGroup>

    <button type="button" aria-expanded={expertExpanded} onClick={() => onExpertExpandedChange(!expertExpanded)} className="mt-2 flex w-full items-center justify-between rounded-lg px-1 py-1 text-[11px] font-semibold text-zinc-500 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]">
      {t(expertExpanded ? "compatibilityExpertHide" : "compatibilityExpertShow")}<ChevronDown size={13} className={cn("transition-transform", expertExpanded && "rotate-180")} />
    </button>
    {overridden ? <div className="mt-1 flex items-start gap-1.5 rounded-lg bg-amber-500/10 p-2 text-[10px] text-amber-700 dark:text-amber-300"><TriangleAlert size={12} className="mt-0.5 shrink-0" /><span>{t("compatibilityOverrideWarning")}</span></div> : null}
    <button type="button" disabled={!overridden} onClick={() => void onChange(AUTOMATIC_COMPATIBILITY_PATCH)} className="mt-2 flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2 py-1 text-[11px] font-semibold text-zinc-500 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] disabled:opacity-40 dark:border-zinc-700"><RotateCcw size={12} />{t("compatibilityRestoreAutomatic")}</button>
  </div>;
}
